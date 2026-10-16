/**
 * MCP client for the FarmAssist server: connects over Streamable HTTP with the farm's bearer token,
 * discovers tools and calls them. Uses the official MCP SDK client, so it talks to the server exactly as
 * any other MCP host would.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolSpec } from './model.js';

export interface ToolCallResult {
  isError: boolean;
  /** Human-readable text written by the server (amounts formatted by server code). */
  text: string;
  /** Machine-readable result, when the tool returns one. */
  structured?: Record<string, unknown>;
}

/** What the agent needs from an MCP connection. Tests can supply a fake. */
export interface FarmToolClient {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface McpClientOptions {
  url: string;
  token: string;
  /** Custom fetch, e.g. to route requests to an in-process server in tests. */
  fetch?: FetchLike;
}

export class FarmMcpClient implements FarmToolClient {
  private readonly client = new Client({ name: 'farmassist-agent-client', version: '0.1.0' });
  private connected: Promise<void> | undefined;
  private tools: ToolSpec[] | undefined;

  constructor(private readonly options: McpClientOptions) {}

  private connect(): Promise<void> {
    this.connected ??= this.client
      .connect(
        new StreamableHTTPClientTransport(new URL(this.options.url), {
          requestInit: { headers: { Authorization: `Bearer ${this.options.token}` } },
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        }),
      )
      .catch((error: unknown) => {
        this.connected = undefined; // allow a later retry
        throw error;
      });
    return this.connected;
  }

  /** Tool list from the server, cached for the life of this client. */
  async listTools(): Promise<ToolSpec[]> {
    if (this.tools) return this.tools;
    await this.connect();
    const { tools } = await this.client.listTools();
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    return {
      isError: result.isError === true,
      text,
      ...(result.structuredContent ? { structured: result.structuredContent as Record<string, unknown> } : {}),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
