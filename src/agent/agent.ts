/**
 * FarmAssist agent: turns a farmer's message into MCP tool calls and a short reply.
 *
 * With a model configured it runs the usual tool-use loop (model -> tools -> model ...). Without one, or when
 * the model fails before anything was written, it uses the deterministic fallback parser. Either way every
 * fact comes from the MCP server: the agent never calculates totals, and a model reply containing a number
 * that is not in the tool results (or the farmer's own message) is replaced by the server's own text.
 */
import { ulid } from 'ulid';
import { todayInFarmTimeZone } from '../shared/time.js';
import { confirmationAnswer, confirmationPrompt, MAX_CHANGES_PER_CONFIRMATION, type PendingAction, type ProposedChange } from './confirm.js';
import { decideFallback, FALLBACK_HELP } from './fallback.js';
import type { FarmToolClient, ToolCallResult } from './mcp-client.js';
import type { AgentModel, ChatBlock, ChatMessage, ToolSpec } from './model.js';

/** System prompt for one turn. The model is told today's date, since it cannot know it (and guesses badly). */
export const agentSystemPrompt = (today: string) => [
  'You are FarmAssist, a helpful assistant for a small Indian dairy and crop farmer. The farmer may write in simple English or Hinglish.',
  `Today is ${today} (India time). Resolve words like "today", "yesterday" or a month name against this date; leave dates out of tool calls when the farmer means today.`,
  'Use the tools for every fact about the farm. Record expenses and activities with the tools; never just say you did.',
  'Never ask the farmer to confirm a change yourself (no "Shall I record...?"): call the tool straight away. FarmAssist itself reads every change back when needed and saves it only after the farmer agrees.',
  'Rules:',
  '- Never calculate, estimate or round totals yourself. Quote amounts exactly as the tool results write them (for example ₹2,500.00).',
  '- Only record an expense when the farmer has stated the amount. If the amount or category is unclear, ask a short question instead of guessing. Use the category "other" only when the farmer says what it was and no other category fits.',
  '- To correct an expense, use its entryId from an earlier tool result in this conversation. Never invent ids.',
  '- New records may have any date up to today, including dates in the past. Only future dates are refused.',
  '- Animals: register each new animal with register_animal (one call per animal) and rename or change one with update_animal. Use list_animals for "how many cows". Do not use activities to name animals.',
  '- Milk: record_milk (litres, per animal or for the whole herd); for any question about milk use get_milk_summary. Crops: record_sowing when planted, record_harvest for what came back, list_crops to compare. Insurance: add_insurance. Reminders: add_reminder and list_reminders.',
  '- Refer to animals, crops and reminders by name; only use an id that a tool result in this conversation gave you.',
  '- Pass quantities exactly as the farmer said them, with their unit (for example quantity 30 and unit "quintal"). Never convert units yourself.',
  '- When an animal is sold or dies, call update_animal with only animalName and status ("sold" or "died"). Never copy details from one animal to another.',
  '- To add details to an earlier activity, record a new activity (type "other" if nothing else fits) with the details in the note; earlier activities stay as they were.',
  '- If a tool returns an error, say plainly that nothing was saved and why. Never say something was recorded, updated or saved unless a tool result confirms it.',
  '- For a whole month or another explicit range, pass "from" and "to" (YYYY-MM-DD) and no "period".',
  '- For "how much" or "what did I spend" questions, call get_expense_summary (or get_daily_summary for one day) and repeat its total. list_expenses is only for showing entries: mention how many there are and at most three of them, and never total them.',
  '- Reply in 1 to 3 short, plain sentences: no markdown, lists or headings, and never mention entry ids. Do not give veterinary, medical or financial advice.',
].join('\n');

/** What the model is told when a change is held for the farmer's confirmation (voice turns). */
const HELD_FOR_CONFIRMATION =
  'Accepted. FarmAssist will read it back to the farmer and save it after they say yes; do not ask them yourself. ' +
  'Now call the tools for every other change in the farmer\'s message (for example each of the other animals) before replying. ' +
  'When nothing is left, reply with one short sentence.';

/** Sent to the model, as FarmAssist (not the farmer), when it claims a save without calling a tool. */
const UNBACKED_CLAIM =
  '[FarmAssist system note, not from the farmer] Nothing was saved: you did not call any tool. ' +
  'Call the right tool now for what the farmer asked, or ask the farmer a short question if something is unclear.';

/** Operator-only tools that the model is not offered (they only cost a round trip). */
const HIDDEN_FROM_MODEL = new Set(['health_check']);
/** Tools that write; the agent gives each call a clientRequestId so a retry can never record twice. */
const WRITE_TOOLS = new Set(['record_expense', 'record_farm_activity', 'register_animal', 'record_milk', 'record_sowing', 'record_harvest', 'add_insurance', 'add_reminder']);
/** Every tool that changes the farm's records (creates, corrects or updates). */
const CHANGING_TOOLS = new Set([...WRITE_TOOLS, 'correct_entry', 'update_animal', 'complete_reminder']);

/** True when a reply says something was saved or changed ("has been updated", "I recorded", ...). */
export function claimsSuccess(text: string): boolean {
  const done = '(recorded|updated|saved|corrected|added|changed|logged|noted|stored)';
  return new RegExp(`\\b(has|have|had|was|were|is|are)\\s+(now\\s+)?(been\\s+)?(successfully\\s+)?${done}\\b|\\b(i|i've|i have|we've)\\s+(successfully\\s+)?${done}\\b|^\\s*${done}\\b`, 'i').test(text);
}

/** "only expenses can be corrected" -> "Only expenses can be corrected." */
const sentence = (text: string) => {
  const t = text.replace(/^MCP error -?\d+:\s*/, '').trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
};
const MAX_HISTORY_MESSAGES = 24;

export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  result: ToolCallResult;
}

export interface AgentTurn {
  reply: string;
  /** 'model' when the model wrote the reply; 'fallback' when the deterministic parser handled the message. */
  mode: 'model' | 'fallback';
  toolCalls: AgentToolCall[];
  /** Why the model was not used for this turn, when it was configured but failed. */
  modelError?: string;
  /** 'replaced' when the model's reply contained an unverified number and was swapped for server text. */
  numberCheck?: 'passed' | 'replaced';
  /** The numbers that failed the check (diagnostics for local tools; never logged in production). */
  unverifiedNumbers?: string[];
  /** 'replaced' when the model claimed a change that the server refused. */
  claimCheck?: 'replaced';
  /** Set when a write is waiting for the farmer's yes (voice turns); `reply` is the read-back question. */
  confirmation?: { prompt: string };
  /** The farmer answered a confirmation question. */
  confirmed?: boolean;
}

export interface HandleOptions {
  /** Hold every ledger change until the farmer confirms it (used for spoken messages). */
  confirmWrites?: boolean;
}

/** Everything the agent remembers between messages; stored by the hosted chat backend between requests. */
export interface AgentState {
  history: ChatMessage[];
  lastExpenseId?: string | undefined;
  /** A write waiting for confirmation; only the very next message can confirm it. */
  pending?: PendingAction | undefined;
}

export interface FarmAgentOptions {
  tools: FarmToolClient;
  /** Conversation so far, from exportState() of an earlier agent. */
  state?: AgentState | undefined;
  model?: AgentModel | undefined;
  now?: () => Date;
  /** Model/tool rounds per message before the agent stops and reports what was done. */
  maxToolRounds?: number;
}

/** Every id format a tool can return: ledger entries and farm records (see record-store.ts). */
const ENTRY_ID = /\b(?:(?:exp|act|milk|rem)_\d{8}_|(?:ani|crop|ins)_|hrv_[0-9A-HJKMNP-TV-Z]{26}_)[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Every entry id that appeared in this conversation (tool results, earlier replies' notes). */
function knownEntryIds(messages: readonly ChatMessage[], lastExpenseId: string | undefined): Set<string> {
  const ids = new Set(JSON.stringify(messages).match(ENTRY_ID) ?? []);
  if (lastExpenseId) ids.add(lastExpenseId);
  return ids;
}

/**
 * The checks of the tool's own published JSON Schema that matter before a read-back: required fields,
 * allowed values and basic types. The server still validates everything; this only stops the farmer from
 * being asked to confirm a request that cannot work (e.g. "record undefined for Lakshmi").
 */
interface PropertySpec {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  items?: Record<string, unknown>;
}

export function schemaProblems(schema: Record<string, unknown>, args: Record<string, unknown>, path = ''): string[] {
  const properties = (schema.properties ?? {}) as Record<string, PropertySpec>;
  const problems = ((schema.required ?? []) as string[]).filter((field) => args[field] === undefined || args[field] === null).map((field) => `"${path}${field}" is required`);
  for (const [field, value] of Object.entries(args)) {
    const spec = properties[field];
    const name = `"${path}${field}"`;
    if (!spec || value === undefined) continue;
    if (spec.enum && !spec.enum.includes(value)) problems.push(`${name} must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    else if (spec.type === 'number' || spec.type === 'integer') {
      if (typeof value !== 'number') problems.push(`${name} must be a number`);
      else if ((spec.exclusiveMinimum !== undefined && value <= spec.exclusiveMinimum) || (spec.minimum !== undefined && value < spec.minimum)) problems.push(`${name} is too small`);
      else if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${name} is too large`);
    } else if (spec.type === 'string' && typeof value !== 'string') problems.push(`${name} must be text`);
    else if (spec.type === 'array') {
      if (!Array.isArray(value)) problems.push(`${name} must be a list`);
      else if (spec.items?.type === 'object') {
        value.forEach((item, i) => {
          if (item && typeof item === 'object') problems.push(...schemaProblems(spec.items!, item as Record<string, unknown>, `${path}${field}[${i}].`));
          else problems.push(`"${path}${field}[${i}]" must be an object`);
        });
      }
    }
  }
  return problems;
}

/** Identifiers that must come from the farmer's own words. */
const IDENTIFIER_FIELDS = new Set(['policyNumber', 'tagNumber']);

/** What the farmer said in this conversation (their messages only: no tool results, no system notes). */
export function farmerWords(messages: readonly ChatMessage[]): { text: string; numbers: Set<string> } {
  const text = messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text' && !b.text.startsWith('[FarmAssist system note'))
    .map((b) => b.text)
    .join('\n');
  const numbers = new Set(numbersIn(text));
  // "1.5 lakh", "2 thousand", "5k": the amount a model sends is the multiplied value.
  const scale: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, thousand: 1e3, hazaar: 1e3, hazar: 1e3, k: 1e3 };
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lac|crores?|cr|thousand|hazaa?r|k)\b/gi)) {
    numbers.add(String(Math.round(Number(m[1]!.replaceAll(',', '')) * scale[m[2]!.toLowerCase()]! * 100) / 100));
  }
  return { text, numbers };
}

const compact = (s: string) => s.toLowerCase().replace(/[\s\-_/.]/g, '');

/**
 * Keeps only numbers and identifiers the farmer said. An unsaid optional value is removed (so the read-back
 * and the saved record never contain it); an unsaid required value makes the call fail with a request to ask.
 */
export function keepOnlySaid(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  said: { text: string; numbers: Set<string> },
  path = '',
): { args: Record<string, unknown>; error?: string } {
  if (!schema) return { args };
  const properties = (schema.properties ?? {}) as Record<string, PropertySpec>;
  const required = new Set((schema.required ?? []) as string[]);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    const spec = properties[field];
    if (typeof value === 'number' && (spec?.type === 'number' || spec?.type === 'integer') && !said.numbers.has(String(value))) {
      if (required.has(field)) return { args, error: `"${path}${field}" ${value} is not something the farmer said. Ask the farmer for it instead of guessing` };
      continue;
    }
    if (IDENTIFIER_FIELDS.has(field) && typeof value === 'string' && !compact(said.text).includes(compact(value))) continue;
    if (spec?.type === 'array' && spec.items?.type === 'object' && Array.isArray(value)) {
      const items: unknown[] = [];
      for (const [i, item] of value.entries()) {
        if (!item || typeof item !== 'object') {
          items.push(item);
          continue;
        }
        const checked = keepOnlySaid(spec.items, item as Record<string, unknown>, said, `${path}${field}[${i}].`);
        if (checked.error) return { args, error: checked.error };
        items.push(checked.args);
      }
      out[field] = items;
      continue;
    }
    out[field] = value;
  }
  return { args: out };
}

/** Values models put in optional fields instead of leaving them out. */
const PLACEHOLDER = /^\s*(n\/?a|na|none|nil|null|unknown|unspecified|not (given|known|provided|specified|said|mentioned)|-+|\?+)\s*$/i;

/**
 * Removes what the farmer did not say: placeholder text and zero amounts in optional fields (seen live:
 * "policy number N/A", "cover ₹0"), and fixes the case of enum values ("Cow" -> "cow").
 */
export function cleanArgs(schema: Record<string, unknown> | undefined, args: Record<string, unknown>): Record<string, unknown> {
  if (!schema) return args;
  const properties = (schema.properties ?? {}) as Record<string, PropertySpec>;
  const required = new Set((schema.required ?? []) as string[]);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(args)) {
    const spec = properties[field];
    if (spec && !required.has(field)) {
      if (typeof value === 'string' && (value.trim() === '' || PLACEHOLDER.test(value))) continue;
      if (typeof value === 'number' && value <= 0 && (spec.exclusiveMinimum === 0 || (spec.minimum ?? 0) > 0)) continue;
    }
    if (spec?.enum && typeof value === 'string') {
      const match = spec.enum.find((e) => typeof e === 'string' && (e === value.trim().toLowerCase() || `${e}s` === value.trim().toLowerCase()));
      out[field] = match ?? value;
      continue;
    }
    if (spec?.type === 'array' && spec.items?.type === 'object' && Array.isArray(value)) {
      out[field] = value.map((item) => (item && typeof item === 'object' ? cleanArgs(spec.items, item as Record<string, unknown>) : item));
      continue;
    }
    out[field] = value;
  }
  return out;
}

/** Why the agent will not send this call, or undefined. Only corrections are checked: they name existing entries. */
export function preflightError(
  name: string,
  args: Record<string, unknown>,
  known: ReadonlySet<string>,
  schema?: Record<string, unknown>,
): string | undefined {
  const invalid = schema ? schemaProblems(schema, args) : [];
  if (invalid.length > 0) return `invalid arguments (${invalid.join('; ')}). Fix them and call ${name} again`;
  // Any record id in a change must have come from this conversation; names are looked up by the server.
  for (const field of ['animalId', 'cropId', 'reminderId']) {
    const value = args[field];
    if (typeof value === 'string' && !known.has(value)) {
      return `that ${field} did not come from a tool result in this conversation. Use the name instead (animalName, or crop and field), or look it up with list_animals, list_crops or list_reminders, instead of guessing an id`;
    }
  }
  if (name !== 'correct_entry' || args.entryId === undefined) return undefined; // `match` lookups are checked by the server
  const id = String(args.entryId);
  if (id.startsWith('act_')) return 'saved activities cannot be edited. To add details, record a new activity with them in the note';
  if (!known.has(id)) return 'that entryId did not come from a tool result in this conversation. Find the expense with list_expenses (or use match with its date and category) instead of guessing an id';
  return undefined;
}

/**
 * Fields the model is not offered: the retry id (the agent fills it in) and animal/crop ids. Active animal
 * names are unique, so names are enough, and models invent ids (seen live) but say names correctly.
 */
const MODEL_HIDDEN_FIELDS = ['clientRequestId', 'animalId', 'cropId'];

/** Tool arguments without the fields the model must not set (some models copy them from history). */
function withoutRequestId(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => !MODEL_HIDDEN_FIELDS.includes(k)));
}

/** The tool as the model sees it. */
function withoutRequestIdField(tool: ToolSpec): ToolSpec {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  if (!schema.properties || !MODEL_HIDDEN_FIELDS.some((f) => f in schema.properties!)) return tool;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !MODEL_HIDDEN_FIELDS.includes(k)));
  return { ...tool, inputSchema: { ...schema, properties, ...(schema.required ? { required: schema.required.filter((r) => !MODEL_HIDDEN_FIELDS.includes(r)) } : {}) } };
}

/** Conversations stored before several changes could be held at once kept a single { name, args }. */
function normalisePending(pending: unknown): PendingAction | undefined {
  if (!pending || typeof pending !== 'object') return undefined;
  const p = pending as Partial<PendingAction> & Partial<ProposedChange>;
  if (Array.isArray(p.changes)) return p as PendingAction;
  if (typeof p.name === 'string' && p.args) return { changes: [{ name: p.name, args: p.args }], prompt: String(p.prompt ?? ''), mode: p.mode ?? 'model' };
  return undefined;
}

/** The server's human-readable text without the JSON copy it appends after the first line(s). */
export function serverText(result: ToolCallResult): string {
  const lines = result.text.split('\n');
  const jsonStart = lines.findIndex((line) => line.trimStart().startsWith('{'));
  return (jsonStart === -1 ? lines : lines.slice(0, jsonStart)).join(' ').trim() || result.text.trim();
}

/**
 * Text the farmer should see: without reasoning blocks some models emit (Nova writes <thinking>...</thinking>)
 * and without the id annotations this agent adds to its own history.
 */
export function cleanModelText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, ' ')
    .replace(/\s*\[entryId:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Numbers written in text, normalised ("₹2,500.00" -> "2500", "74%" -> "74"). */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => String(Number(m[0].replaceAll(',', ''))));
}

/** Only numbers that state an amount or quantity: "₹2,500", "74%", "12 litres", "3 quintal", "2 acres". */
export function quantityNumbersIn(text: string): string[] {
  const n = String.raw`\d[\d,]*(?:\.\d+)?`;
  const units = String.raw`rupees?|rs\b|inr|paise|%|percent|kgs?|kilos?|kilograms?|grams?|g\b|litres?|liters?|ltrs?|l\b|ml\b|quintals?|qtls?|tonnes?|tons?|acres?|hectares?|bags?`;
  const pattern = new RegExp(String.raw`(?:₹|\brs\.?|\binr)\s*(${n})|(${n})\s*(?:${units})`, 'gi');
  return [...text.matchAll(pattern)].map((m) => String(Number((m[1] ?? m[2])!.replaceAll(',', ''))));
}

export class FarmAgent {
  private readonly tools: FarmToolClient;
  private readonly model: AgentModel | undefined;
  private readonly now: () => Date;
  private readonly maxToolRounds: number;
  private history: ChatMessage[] = [];
  private lastExpenseId: string | undefined;
  private pending: PendingAction | undefined;

  constructor(options: FarmAgentOptions) {
    this.tools = options.tools;
    this.model = options.model;
    this.now = options.now ?? (() => new Date());
    this.maxToolRounds = options.maxToolRounds ?? 6;
    this.history = options.state?.history ?? [];
    this.lastExpenseId = options.state?.lastExpenseId;
    this.pending = normalisePending(options.state?.pending);
  }

  exportState(): AgentState {
    return {
      history: this.history,
      ...(this.lastExpenseId ? { lastExpenseId: this.lastExpenseId } : {}),
      ...(this.pending ? { pending: this.pending } : {}),
    };
  }

  get modelId(): string | undefined {
    return this.model?.modelId;
  }

  async handle(message: string, options: HandleOptions = {}): Promise<AgentTurn> {
    // A pending write lives for exactly one message: it is confirmed, cancelled, or dropped.
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      const answer = confirmationAnswer(message);
      if (answer === 'yes') {
        const turn = await this.runConfirmed(pending);
        this.rememberConfirmed(pending, turn);
        return turn;
      }
      // Cancelled or dropped: the history keeps one neutral line, never the read-back dialogue.
      this.rememberPlain(pending.request ?? message, answer === 'no' ? 'The farmer cancelled this; nothing was saved.' : 'Not confirmed by the farmer; nothing was saved.');
      if (answer === 'no') return { reply: 'Okay, nothing was saved.', mode: pending.mode, toolCalls: [], confirmed: false };
    }

    const confirmWrites = options.confirmWrites === true;
    const { turn, transcript } = this.model
      ? await this.handleWithModel(message, this.model, confirmWrites)
      : { turn: await this.handleWithFallback(message, confirmWrites), transcript: undefined };
    const nowHeld = this.pending as PendingAction | undefined; // set again by hold() during this turn
    if (turn.confirmation && nowHeld) {
      // The question is not kept in the history: models copy what they see there and start asking
      // "Shall I...?" themselves instead of calling the tools (seen with Nova Lite). Kept for later instead.
      nowHeld.request = message;
      return turn;
    }
    if (transcript) this.remember(transcript);
    else this.rememberAsText(message, turn);
    return turn;
  }

  /**
   * A confirmed change goes into the history as if the model had called the tools straight away:
   * the farmer's request, the tool calls, the server's results and the reply. That is the behaviour the
   * model should repeat next time.
   */
  private rememberConfirmed(pending: PendingAction, turn: AgentTurn): void {
    // Ids must be unique across the whole history, or the model can pair results with the wrong calls.
    const ids = pending.changes.map(() => `confirmed-${ulid()}`);
    const uses: ChatBlock[] = pending.changes.map((c, i) => ({ type: 'tool_use', id: ids[i]!, name: c.name, input: withoutRequestId(c.args) }));
    const results: ChatBlock[] = turn.toolCalls.map((c, i) => ({ type: 'tool_result', toolUseId: ids[i]!, text: c.result.text, isError: c.result.isError }));
    this.remember([
      ...this.history,
      { role: 'user', content: [{ type: 'text', text: pending.request ?? 'yes' }] },
      { role: 'assistant', content: uses },
      { role: 'user', content: results },
      { role: 'assistant', content: [{ type: 'text', text: turn.reply }] },
    ]);
  }

  private rememberPlain(userText: string, assistantText: string): void {
    this.history.push({ role: 'user', content: [{ type: 'text', text: userText }] }, { role: 'assistant', content: [{ type: 'text', text: assistantText }] });
    this.trimHistory();
  }

  /** Returns the turn and, when the model finished normally, the full transcript (tool blocks included) to keep. */
  private async handleWithModel(message: string, model: AgentModel, confirmWrites: boolean): Promise<{ turn: AgentTurn; transcript?: ChatMessage[] }> {
    const toolCalls: AgentToolCall[] = [];
    const held: ProposedChange[] = [];
    let nudged = false;
    const messages: ChatMessage[] = [...this.history, { role: 'user', content: [{ type: 'text', text: message }] }];
    try {
      const tools = (await this.tools.listTools()).filter((t) => !HIDDEN_FROM_MODEL.has(t.name)).map(withoutRequestIdField);
      for (let round = 0; round < this.maxToolRounds; round++) {
        const reply = await model.respond({ system: agentSystemPrompt(todayInFarmTimeZone(this.now())), messages, tools });
        messages.push({ role: 'assistant', content: reply.content });
        // Retry ids are the agent's job: one the model sends (often copied from history) is dropped.
        const uses = reply.content
          .filter((b): b is Extract<ChatBlock, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((u) => ({ ...u, input: cleanArgs(tools.find((t) => t.name === u.name)?.inputSchema, withoutRequestId(u.input)) }));
        // Voice: once the model has asked for everything, the farmer hears one read-back of all of it.
        if (uses.length === 0 && held.length > 0) return { turn: { ...this.hold(held, 'model'), toolCalls } };
        if (uses.length === 0) {
          const text = cleanModelText(
            reply.content
              .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')
              .map((b) => b.text)
              .join(' '),
          );
          // A claim that something was saved, with nothing saved this turn, is never shown (seen live with
          // Nova Lite: "Recorded sowing paddy..." without any tool call). The model gets one chance to call the tool.
          // (A change that was tried and refused is handled below, with the server's own reason.)
          const triedChange = toolCalls.some((c) => CHANGING_TOOLS.has(c.name));
          if (claimsSuccess(text) && !triedChange) {
            if (!nudged) {
              nudged = true;
              console.warn(JSON.stringify({ level: 'warn', message: 'Model claimed a save without a tool call; asking it to call the tool' }));
              messages.push({ role: 'user', content: [{ type: 'text', text: UNBACKED_CLAIM }] });
              continue;
            }
            return { turn: { reply: 'Nothing was saved. Please say that again in a few words, for example "Lakshmi gave 8 litres this morning".', mode: 'model', toolCalls, claimCheck: 'replaced' } };
          }
          const turn = await this.checkedModelReply(text, message, toolCalls);
          if (turn.mode === 'fallback') return { turn }; // the parser answered instead; keep it as text
          // Remember what the farmer was actually shown, not the model's raw draft.
          messages[messages.length - 1] = { role: 'assistant', content: [{ type: 'text', text: turn.reply }] };
          return { turn, transcript: messages };
        }
        // A correction must name an expense this conversation has actually seen. Refuse anything else here,
        // with guidance, so the model can recover now instead of asking the farmer to confirm a doomed change.
        // Ids from before this response only: the model's own tool request must not vouch for its id.
        const known = knownEntryIds(messages.slice(0, -1), this.lastExpenseId);
        const schemaOf = (name: string) => tools.find((t) => t.name === name)?.inputSchema;
        // Every number and identifier in a change must be something the farmer said (seen live: Nova invented
        // "policy number UND001, cover ₹10,000"). Unsaid optional values are dropped; unsaid required ones refused.
        const said = farmerWords(messages);
        const unsaid = new Map<string, string>();
        for (const u of uses) {
          if (!CHANGING_TOOLS.has(u.name)) continue;
          // "No, it was 2400" means the expense just talked about; models often leave out which one.
          if (u.name === 'correct_entry' && u.input.entryId === undefined && u.input.match === undefined && this.lastExpenseId) {
            u.input = { ...u.input, entryId: this.lastExpenseId };
          }
          const checked = keepOnlySaid(schemaOf(u.name), u.input, said);
          u.input = checked.args;
          if (checked.error) unsaid.set(u.id, checked.error);
        }
        const refused = new Map(
          uses
            .map((u) => [u.id, unsaid.get(u.id) ?? preflightError(u.name, u.input, known, CHANGING_TOOLS.has(u.name) ? schemaOf(u.name) : undefined)] as const)
            .filter((r): r is [string, string] => r[1] !== undefined),
        );
        if (refused.size > 0) {
          const results: ChatBlock[] = uses.map((u) => {
            const error = refused.get(u.id) ?? 'not run, because another request in this step was refused; send it again if it is still needed';
            if (refused.has(u.id)) toolCalls.push({ name: u.name, args: u.input, result: { isError: true, text: error } });
            return { type: 'tool_result', toolUseId: u.id, text: error, isError: true };
          });
          messages.push({ role: 'user', content: results });
          continue;
        }
        const results: ChatBlock[] = [];
        for (const use of uses) {
          // Voice: changes are collected, not run. Models often ask for one per round ("4 cows" = 4 rounds),
          // so the model is told each one is held and asked for the rest.
          if (confirmWrites && CHANGING_TOOLS.has(use.name)) {
            if (!held.some((h) => h.name === use.name && JSON.stringify(h.args) === JSON.stringify(use.input))) held.push({ name: use.name, args: use.input });
            results.push({ type: 'tool_result', toolUseId: use.id, text: HELD_FOR_CONFIRMATION, isError: false });
            continue;
          }
          const call = await this.runTool(use.name, use.input);
          toolCalls.push(call);
          results.push({ type: 'tool_result', toolUseId: use.id, text: call.result.text, isError: call.result.isError });
        }
        messages.push({ role: 'user', content: results });
      }
      if (held.length > 0) return { turn: { ...this.hold(held, 'model'), toolCalls } };
      return { turn: { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls } };
    } catch (error) {
      const modelError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(JSON.stringify({ level: 'error', message: 'Agent model turn failed', modelId: model.modelId, error: error instanceof Error ? error.name : 'Unknown' }));
      // Nothing held has been written, so it can still be read back.
      if (held.length > 0) return { turn: { ...this.hold(held, 'model'), toolCalls, modelError } };
      // Something may already have been written this turn: report it rather than risk doing it twice.
      if (toolCalls.length > 0) return { turn: { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls, modelError } };
      return { turn: { ...(await this.handleWithFallback(message, confirmWrites)), modelError } };
    }
  }

  private async handleWithFallback(message: string, confirmWrites = false): Promise<AgentTurn> {
    const decision = decideFallback(message, { lastExpenseId: this.lastExpenseId }, todayInFarmTimeZone(this.now()));
    if (decision.kind === 'reply') return { reply: decision.text, mode: 'fallback', toolCalls: [] };
    if (confirmWrites && CHANGING_TOOLS.has(decision.name)) return this.hold([{ name: decision.name, args: decision.args }], 'fallback');
    const call = await this.runTool(decision.name, decision.args);
    return { reply: serverText(call.result), mode: 'fallback', toolCalls: [call] };
  }

  /** Holds writes until the farmer confirms them. Ids are fixed now, so a retried "yes" cannot record twice. */
  private hold(proposed: ProposedChange[], mode: 'model' | 'fallback'): AgentTurn {
    const changes = proposed.slice(0, MAX_CHANGES_PER_CONFIRMATION).map(({ name, args }) => ({
      name,
      args: WRITE_TOOLS.has(name) && !args.clientRequestId ? { ...args, clientRequestId: `agent-${ulid()}` } : { ...args },
    }));
    const extra = proposed.length > changes.length ? ` (I can save ${MAX_CHANGES_PER_CONFIRMATION} at a time; please send the rest again after this.)` : '';
    const prompt = `${confirmationPrompt(changes)}${extra}`;
    this.pending = { changes, prompt, mode };
    return { reply: prompt, mode, toolCalls: [], confirmation: { prompt } };
  }

  /** Runs every confirmed change, in order, and reports each one in the server's own words. */
  private async runConfirmed(pending: PendingAction): Promise<AgentTurn> {
    const toolCalls: AgentToolCall[] = [];
    for (const change of pending.changes) toolCalls.push(await this.runTool(change.name, change.args));
    const saved = toolCalls.filter((c) => !c.result.isError).map((c) => serverText(c.result));
    const refused = toolCalls.filter((c) => c.result.isError).map((c) => sentence(serverText(c.result)));
    const reply =
      refused.length === 0
        ? saved.join(' ')
        : saved.length === 0
          ? `Nothing was saved. ${refused.join(' ')}`
          : `${saved.join(' ')} Not saved: ${refused.join(' ')}`;
    return { reply, mode: pending.mode, toolCalls, confirmed: true };
  }

  /** Calls one tool, adding a clientRequestId to writes and retrying once (same id) if the request itself fails. */
  private async runTool(name: string, input: Record<string, unknown>): Promise<AgentToolCall> {
    const args = WRITE_TOOLS.has(name) && !input.clientRequestId ? { ...input, clientRequestId: `agent-${ulid()}` } : { ...input };
    let result: ToolCallResult;
    try {
      result = await this.tools.callTool(name, args);
    } catch {
      result = await this.tools.callTool(name, args);
    }
    const entry = result.structured?.entry as { entryId?: unknown; category?: unknown } | undefined;
    if (!result.isError && typeof entry?.entryId === 'string' && entry.category !== undefined) this.lastExpenseId = entry.entryId;
    return { name, args, result };
  }

  /**
   * Keeps the model's reply only if every number in it appears in this turn's tool results or the farmer's
   * message. Otherwise the server's own text is shown; if no tool ran (nothing was written), the
   * deterministic parser answers instead, e.g. with its own clarifying question.
   */
  private async checkedModelReply(text: string, message: string, toolCalls: AgentToolCall[]): Promise<AgentTurn> {
    // A ledger must never say something was saved when it was not: if every write this turn failed,
    // a reply that claims success is replaced by the server's own reason.
    const writes = toolCalls.filter((c) => CHANGING_TOOLS.has(c.name));
    const failed = writes.filter((c) => c.result.isError);
    if (failed.length > 0 && failed.length === writes.length && claimsSuccess(text)) {
      console.warn(JSON.stringify({ level: 'warn', message: 'Model reply replaced: claimed success after a failed write' }));
      return { reply: `Nothing was saved. ${sentence(serverText(failed[0]!.result))}`, mode: 'model', toolCalls, claimCheck: 'replaced' };
    }
    // With tool results this turn, every number must come from them (or the farmer). Without any, the reply
    // can only be a question or a remark: only amounts and quantities are checked, against the whole
    // conversation, so ordinary numbers ("these 3 cows", list numbering) no longer throw the reply away.
    const allowed = new Set([...numbersIn(message), ...toolCalls.flatMap((c) => numbersIn(c.result.text))]);
    if (toolCalls.length === 0) for (const n of numbersIn(JSON.stringify(this.history))) allowed.add(n);
    const checked = toolCalls.length === 0 ? quantityNumbersIn(text) : numbersIn(text);
    const unverified = checked.filter((n) => !allowed.has(n));
    if (text && unverified.length === 0) return { reply: text, mode: 'model', toolCalls, numberCheck: 'passed' };
    // An empty reply is not a number problem. After tools ran, the server's own words answer the farmer;
    // with nothing done at all, the model failed this turn and the parser takes over.
    if (!text && toolCalls.length > 0) return { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls };
    if (!text) return { ...(await this.handleWithFallback(message)), modelError: 'EmptyReply: the model returned no text and no tool call' };
    console.warn(JSON.stringify({ level: 'warn', message: 'Model reply replaced', unverifiedNumbers: unverified.length, empty: !text }));
    if (toolCalls.length === 0) return { ...(await this.handleWithFallback(message)), numberCheck: 'replaced', unverifiedNumbers: unverified };
    return { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls, numberCheck: 'replaced', unverifiedNumbers: unverified };
  }

  private summariseToolCalls(toolCalls: AgentToolCall[]): string {
    return toolCalls.map((c) => serverText(c.result)).join(' ') || FALLBACK_HELP;
  }

  /** Keeps a model turn's full transcript, so later turns see tool results (and entry ids) exactly as the server wrote them. */
  private remember(transcript: ChatMessage[]): void {
    this.history = transcript;
    this.trimHistory();
  }

  /**
   * Keeps a turn that has no usable transcript (fallback, model error, round limit) as plain text. Entry ids
   * are noted so a model can still correct the entry on a later turn; cleanModelText hides them from replies.
   */
  private rememberAsText(message: string, turn: AgentTurn): void {
    const ids = turn.toolCalls
      .map((c) => (c.result.structured?.entry as { entryId?: string } | undefined)?.entryId)
      .filter((id): id is string => typeof id === 'string');
    const context = ids.length > 0 ? ` [entryId: ${ids.join(', ')}]` : '';
    this.history.push(
      { role: 'user', content: [{ type: 'text', text: message }] },
      { role: 'assistant', content: [{ type: 'text', text: `${turn.reply}${context}` }] },
    );
    this.trimHistory();
  }

  /** Drops the oldest messages, cutting only where a farmer's message starts so tool blocks stay paired. */
  private trimHistory(): void {
    let start = Math.max(0, this.history.length - MAX_HISTORY_MESSAGES);
    while (start < this.history.length && !(this.history[start]!.role === 'user' && this.history[start]!.content[0]?.type === 'text')) start++;
    if (start > 0) this.history = this.history.slice(start);
  }
}
