/**
 * Provider-neutral chat model interface used by the agent, plus the Amazon Bedrock implementation.
 * The agent never sees Bedrock types, so another provider can be added without touching it.
 * Which model runs is configuration only (AGENT_MODEL_ID), e.g. Nova Lite or Claude Haiku: the Converse API
 * handles tool use the same way for both.
 */
import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ContentBlock,
  type Message,
  type ToolResultContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { createBedrockClientFromEnv } from '../services/bedrock-client.js';

/** Bedrock's JSON document type (tool inputs and schemas). */
type DocumentType = NonNullable<ToolUseBlock['input']>;

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ChatBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments, exactly as the MCP server published it. */
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
}

export interface ModelReply {
  content: ChatBlock[];
  /** 'tool_use' when the model wants tools run before it answers. */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
}

export interface AgentModel {
  readonly modelId: string;
  respond(request: ModelRequest): Promise<ModelReply>;
}

function toBedrockBlock(block: ChatBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'tool_use':
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input as DocumentType } };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: [{ text: block.text } satisfies ToolResultContentBlock],
          status: block.isError ? 'error' : 'success',
        },
      };
  }
}

function fromBedrockBlock(block: ContentBlock): ChatBlock | undefined {
  if (block.text !== undefined) return { type: 'text', text: block.text };
  if (block.toolUse) {
    return {
      type: 'tool_use',
      id: block.toolUse.toolUseId ?? '',
      name: block.toolUse.name ?? '',
      input: (block.toolUse.input ?? {}) as Record<string, unknown>,
    };
  }
  return undefined; // reasoning and other block types are not used by the agent
}

export class BedrockAgentModel implements AgentModel {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId: string,
    private readonly maxTokens = 800,
  ) {}

  async respond(request: ModelRequest): Promise<ModelReply> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: request.messages.map((m): Message => ({ role: m.role, content: m.content.map(toBedrockBlock) })),
        ...(request.tools.length > 0
          ? {
              toolConfig: {
                tools: request.tools.map((t) => ({
                  toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as DocumentType } },
                })),
              },
            }
          : {}),
        inferenceConfig: { maxTokens: this.maxTokens, temperature: 0 },
      }),
    );
    const content = (response.output?.message?.content ?? []).map(fromBedrockBlock).filter((b): b is ChatBlock => b !== undefined);
    const stopReason = response.stopReason === 'tool_use' || response.stopReason === 'end_turn' || response.stopReason === 'max_tokens' ? response.stopReason : 'other';
    return { content, stopReason };
  }
}

/**
 * Builds the agent's model from environment variables, or undefined when none is configured
 * (the agent then uses its deterministic fallback for every message).
 *
 *   AGENT_MODEL_ID   Bedrock model or inference profile id, e.g. apac.amazon.nova-lite-v1:0
 *   plus the account settings read by createBedrockClientFromEnv (BEDROCK_REGION, BEDROCK_ROLE_ARN, BEDROCK_AWS_PROFILE)
 */
export function createAgentModelFromEnv(env: NodeJS.ProcessEnv = process.env): AgentModel | undefined {
  const modelId = env.AGENT_MODEL_ID;
  if (!modelId) return undefined;
  return new BedrockAgentModel(createBedrockClientFromEnv(env, 'farmassist-agent'), modelId);
}
