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
import { decideFallback, FALLBACK_HELP } from './fallback.js';
import type { FarmToolClient, ToolCallResult } from './mcp-client.js';
import type { AgentModel, ChatBlock, ChatMessage } from './model.js';

export const AGENT_SYSTEM_PROMPT = [
  'You are FarmAssist, a helpful assistant for a small Indian dairy and crop farmer. The farmer may write in simple English or Hinglish.',
  'Use the tools for every fact about the farm. Record expenses and activities with the tools; never just say you did.',
  'Rules:',
  '- Never calculate, estimate or round totals yourself. Quote amounts exactly as the tool results write them (for example ₹2,500.00).',
  '- Only record an expense when the farmer has stated the amount. If the amount or category is unclear, ask a short question instead of guessing.',
  '- To correct an expense, use its entryId from an earlier tool result in this conversation. Never invent ids.',
  '- Reply in 1 to 3 short, plain sentences without markdown. Do not give veterinary, medical or financial advice.',
].join('\n');

/** Tools that write; the agent gives each call a clientRequestId so a retry can never record twice. */
const WRITE_TOOLS = new Set(['record_expense', 'record_farm_activity']);
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
}

export interface FarmAgentOptions {
  tools: FarmToolClient;
  model?: AgentModel | undefined;
  now?: () => Date;
  /** Model/tool rounds per message before the agent stops and reports what was done. */
  maxToolRounds?: number;
}

/** The server's human-readable text without the JSON copy it appends after the first line(s). */
export function serverText(result: ToolCallResult): string {
  const lines = result.text.split('\n');
  const jsonStart = lines.findIndex((line) => line.trimStart().startsWith('{'));
  return (jsonStart === -1 ? lines : lines.slice(0, jsonStart)).join(' ').trim() || result.text.trim();
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

  constructor(options: FarmAgentOptions) {
    this.tools = options.tools;
    this.model = options.model;
    this.now = options.now ?? (() => new Date());
    this.maxToolRounds = options.maxToolRounds ?? 4;
  }

  get modelId(): string | undefined {
    return this.model?.modelId;
  }

  async handle(message: string): Promise<AgentTurn> {
    let turn: AgentTurn;
    if (this.model) {
      turn = await this.handleWithModel(message, this.model);
    } else {
      turn = await this.handleWithFallback(message);
    }
    this.remember(message, turn);
    return turn;
  }

  private async handleWithModel(message: string, model: AgentModel): Promise<AgentTurn> {
    const toolCalls: AgentToolCall[] = [];
    const messages: ChatMessage[] = [...this.history, { role: 'user', content: [{ type: 'text', text: message }] }];
    try {
      const tools = await this.tools.listTools();
      for (let round = 0; round < this.maxToolRounds; round++) {
        const reply = await model.respond({ system: AGENT_SYSTEM_PROMPT, messages, tools });
        messages.push({ role: 'assistant', content: reply.content });
        const uses = reply.content.filter((b): b is Extract<ChatBlock, { type: 'tool_use' }> => b.type === 'tool_use');
        if (uses.length === 0) {
          const text = reply.content
            .filter((b): b is Extract<ChatBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
          return this.checkedModelReply(text, message, toolCalls);
        }
        const results: ChatBlock[] = [];
        for (const use of uses) {
          const call = await this.runTool(use.name, use.input);
          toolCalls.push(call);
          results.push({ type: 'tool_result', toolUseId: use.id, text: call.result.text, isError: call.result.isError });
        }
        messages.push({ role: 'user', content: results });
      }
      return { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls };
    } catch (error) {
      const modelError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(JSON.stringify({ level: 'error', message: 'Agent model turn failed', modelId: model.modelId, error: error instanceof Error ? error.name : 'Unknown' }));
      // Something may already have been written this turn: report it rather than risk doing it twice.
      if (toolCalls.length > 0) return { reply: this.summariseToolCalls(toolCalls), mode: 'model', toolCalls, modelError };
      return { ...(await this.handleWithFallback(message)), modelError };
    }
  }

  private async handleWithFallback(message: string): Promise<AgentTurn> {
    const decision = decideFallback(message, { lastExpenseId: this.lastExpenseId }, todayInFarmTimeZone(this.now()));
    if (decision.kind === 'reply') return { reply: decision.text, mode: 'fallback', toolCalls: [] };
    const call = await this.runTool(decision.name, decision.args);
    return { reply: serverText(call.result), mode: 'fallback', toolCalls: [call] };
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

  /** Keeps the model's reply only if every number in it appears in this turn's tool results or the farmer's message. */
  private checkedModelReply(text: string, message: string, toolCalls: AgentToolCall[]): AgentTurn {
    const allowed = new Set([...numbersIn(message), ...toolCalls.flatMap((c) => numbersIn(c.result.text))]);
    const unverified = numbersIn(text).filter((n) => !allowed.has(n));
    if (text && unverified.length === 0) return { reply: text, mode: 'model', toolCalls, numberCheck: 'passed' };
    console.warn(JSON.stringify({ level: 'warn', message: 'Model reply replaced', unverifiedNumbers: unverified.length, empty: !text }));
    return { reply: toolCalls.length > 0 ? this.summariseToolCalls(toolCalls) : FALLBACK_HELP, mode: 'model', toolCalls, numberCheck: 'replaced' };
  }

  private summariseToolCalls(toolCalls: AgentToolCall[]): string {
    return toolCalls.map((c) => serverText(c.result)).join(' ') || FALLBACK_HELP;
  }

  /**
   * Stores the exchange as plain text for the next turn. Tool-use blocks are left out on purpose: the
   * reply already carries the server's facts, and some models reject histories with orphaned tool blocks.
   * The ids the model may need later (e.g. for a correction) are kept in the reply context below.
   */
  private remember(message: string, turn: AgentTurn): void {
    const ids = turn.toolCalls
      .map((c) => (c.result.structured?.entry as { entryId?: string } | undefined)?.entryId)
      .filter((id): id is string => typeof id === 'string');
    const context = ids.length > 0 ? ` [entryId: ${ids.join(', ')}]` : '';
    this.history.push(
      { role: 'user', content: [{ type: 'text', text: message }] },
      { role: 'assistant', content: [{ type: 'text', text: `${turn.reply}${context}` }] },
    );
    if (this.history.length > MAX_HISTORY_MESSAGES) this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
  }
}
