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
import type { AgentModel, ChatBlock, ChatMessage } from './model.js';

/** System prompt for one turn. The model is told today's date, since it cannot know it (and guesses badly). */
export const agentSystemPrompt = (today: string) => [
  'You are FarmAssist, a helpful assistant for a small Indian dairy and crop farmer. The farmer may write in simple English or Hinglish.',
  `Today is ${today} (India time). Resolve words like "today", "yesterday" or a month name against this date; leave dates out of tool calls when the farmer means today.`,
  'Use the tools for every fact about the farm. Record expenses and activities with the tools; never just say you did.',
  'Rules:',
  '- Never calculate, estimate or round totals yourself. Quote amounts exactly as the tool results write them (for example ₹2,500.00).',
  '- Only record an expense when the farmer has stated the amount. If the amount or category is unclear, ask a short question instead of guessing. Use the category "other" only when the farmer says what it was and no other category fits.',
  '- To correct an expense, use its entryId from an earlier tool result in this conversation. Never invent ids.',
  '- New records may have any date up to today, including dates in the past. Only future dates are refused.',
  '- To add details to an earlier activity (for example a calf\'s name), record a new activity (type "other" if nothing else fits) with the details in the note; earlier activities stay as they were.',
  '- If a tool returns an error, say plainly that nothing was saved and why. Never say something was recorded, updated or saved unless a tool result confirms it.',
  '- For a whole month or another explicit range, pass "from" and "to" (YYYY-MM-DD) and no "period".',
  '- For "how much" or "what did I spend" questions, call get_expense_summary (or get_daily_summary for one day) and repeat its total. list_expenses is only for showing entries: mention how many there are and at most three of them, and never total them.',
  '- Reply in 1 to 3 short, plain sentences: no markdown, lists or headings, and never mention entry ids. Do not give veterinary, medical or financial advice.',
].join('\n');

/** Operator-only tools that the model is not offered (they only cost a round trip). */
const HIDDEN_FROM_MODEL = new Set(['health_check']);
/** Tools that write; the agent gives each call a clientRequestId so a retry can never record twice. */
const WRITE_TOOLS = new Set(['record_expense', 'record_farm_activity']);
/** Every tool that changes the ledger (creates or corrects). */
const CHANGING_TOOLS = new Set([...WRITE_TOOLS, 'correct_entry']);

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

const ENTRY_ID = /\b(?:exp|act)_\d{8}_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Every entry id that appeared in this conversation (tool results, earlier replies' notes). */
function knownEntryIds(messages: readonly ChatMessage[], lastExpenseId: string | undefined): Set<string> {
  const ids = new Set(JSON.stringify(messages).match(ENTRY_ID) ?? []);
  if (lastExpenseId) ids.add(lastExpenseId);
  return ids;
}

/** Why the agent will not send this call, or undefined. Only corrections are checked: they name existing entries. */
export function preflightError(name: string, args: Record<string, unknown>, known: ReadonlySet<string>): string | undefined {
  if (name !== 'correct_entry' || args.entryId === undefined) return undefined; // `match` lookups are checked by the server
  const id = String(args.entryId);
  if (id.startsWith('act_')) return 'saved activities cannot be edited. To add details, record a new activity with them in the note';
  if (!known.has(id)) return 'that entryId did not come from a tool result in this conversation. Find the expense with list_expenses (or use match with its date and category) instead of guessing an id';
  return undefined;
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
    this.maxToolRounds = options.maxToolRounds ?? 4;
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
      if (answer !== 'other') {
        const turn = answer === 'yes' ? await this.runConfirmed(pending) : { reply: 'Okay, nothing was saved.', mode: pending.mode, toolCalls: [], confirmed: false };
        this.rememberAsText(message, turn);
        return turn;
      }
    }

    const confirmWrites = options.confirmWrites === true;
    if (!this.model) {
      const turn = await this.handleWithFallback(message, confirmWrites);
      this.rememberAsText(message, turn);
      return turn;
    }
    const { turn, transcript } = await this.handleWithModel(message, this.model, confirmWrites);
    if (transcript) this.remember(transcript);
    else this.rememberAsText(message, turn);
    return turn;
  }

  /** Returns the turn and, when the model finished normally, the full transcript (tool blocks included) to keep. */
  private async handleWithModel(message: string, model: AgentModel, confirmWrites: boolean): Promise<{ turn: AgentTurn; transcript?: ChatMessage[] }> {
    const toolCalls: AgentToolCall[] = [];
    const messages: ChatMessage[] = [...this.history, { role: 'user', content: [{ type: 'text', text: message }] }];
    try {
      const tools = (await this.tools.listTools()).filter((t) => !HIDDEN_FROM_MODEL.has(t.name));
      for (let round = 0; round < this.maxToolRounds; round++) {
        const reply = await model.respond({ system: agentSystemPrompt(todayInFarmTimeZone(this.now())), messages, tools });
        messages.push({ role: 'assistant', content: reply.content });
        const uses = reply.content.filter((b): b is Extract<ChatBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        if (uses.length === 0) {
          const text = cleanModelText(
            reply.content
              .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')
              .map((b) => b.text)
              .join(' '),
          );
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
        const refused = new Map(uses.map((u) => [u.id, preflightError(u.name, u.input, known)] as const).filter((r): r is [string, string] => r[1] !== undefined));
        if (refused.size > 0) {
          const results: ChatBlock[] = uses.map((u) => {
            const error = refused.get(u.id) ?? 'not run, because another request in this step was refused; send it again if it is still needed';
            if (refused.has(u.id)) toolCalls.push({ name: u.name, args: u.input, result: { isError: true, text: error } });
            return { type: 'tool_result', toolUseId: u.id, text: error, isError: true };
          });
          messages.push({ role: 'user', content: results });
          continue;
        }
        // Voice: every change the model asked for in this response is held and read back together.
        const changes = confirmWrites ? uses.filter((u) => CHANGING_TOOLS.has(u.name)) : [];
        if (changes.length > 0) return { turn: { ...this.hold(changes.map((u) => ({ name: u.name, args: u.input })), 'model'), toolCalls } };
        const results: ChatBlock[] = [];
        for (const use of uses) {
          const call = await this.runTool(use.name, use.input);
          toolCalls.push(call);
          results.push({ type: 'tool_result', toolUseId: use.id, text: call.result.text, isError: call.result.isError });
        }
        messages.push({ role: 'user', content: results });
      }
      return { turn: { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls } };
    } catch (error) {
      const modelError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(JSON.stringify({ level: 'error', message: 'Agent model turn failed', modelId: model.modelId, error: error instanceof Error ? error.name : 'Unknown' }));
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
    const allowed = new Set([...numbersIn(message), ...toolCalls.flatMap((c) => numbersIn(c.result.text))]);
    const unverified = numbersIn(text).filter((n) => !allowed.has(n));
    if (text && unverified.length === 0) return { reply: text, mode: 'model', toolCalls, numberCheck: 'passed' };
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
