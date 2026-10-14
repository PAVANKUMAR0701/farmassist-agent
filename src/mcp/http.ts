import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateBearer, type ApiTokenGrant } from '../auth/bearer.js';
import { createFarmServer, type FarmServerDeps } from './server.js';

export interface McpHttpConfig {
  /** Browser origins allowed to call the server. Requests without an Origin header (curl, MCP Inspector CLI) are allowed. */
  allowedOrigins: readonly string[];
  /** Bearer tokens accepted by the server, each bound to one farm. */
  apiTokens: readonly ApiTokenGrant[];
  deps: FarmServerDeps;
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Handles one HTTP request to the MCP endpoint using the Streamable HTTP transport.
 *
 * Runs stateless: no Mcp-Session-Id is issued and every request gets a fresh server + transport,
 * so any Lambda instance can answer any request. Responses are plain JSON (no SSE), which suits
 * buffered Lambda responses.
 */
export async function handleMcpRequest(request: Request, config: McpHttpConfig): Promise<Response> {
  // Spec: an Origin header that is present but not allowed MUST get 403 (DNS-rebinding protection).
  const origin = request.headers.get('origin');
  if (origin !== null && !config.allowedOrigins.includes(origin)) {
    return jsonRpcError(403, 'Forbidden: origin not allowed');
  }

  // Spec allows 405 for GET (we offer no server-initiated SSE stream) and for DELETE (no sessions to end).
  if (request.method !== 'POST') {
    return jsonRpcError(405, 'Method not allowed: this MCP endpoint only accepts POST', { Allow: 'POST' });
  }

  // 401 without a WWW-Authenticate header: we have no OAuth metadata to point clients at (static bearer tokens only).
  const authInfo = authenticateBearer(request.headers.get('authorization'), config.apiTokens);
  if (!authInfo) {
    return jsonRpcError(401, 'Unauthorized: missing or invalid bearer token');
  }

  const server = createFarmServer(config.deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    // Accept/Content-Type checks, JSON-RPC parsing, 202 for notifications and the
    // MCP-Protocol-Version 400 check are all done by the SDK transport.
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close();
  }
}
