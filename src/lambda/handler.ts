/**
 * AWS Lambda entry point, invoked through a Lambda Function URL (payload format 2.0).
 * Converts the event into a web-standard Request, runs the same handleMcpRequest() as the local server,
 * and converts the Response back. Only the /mcp path is served.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { handleMcpRequest, type McpHttpConfig } from '../mcp/http.js';
import { DynamoLedgerRepository } from '../repositories/dynamodb-ledger-repository.js';

export const MCP_PATH = '/mcp';

/** Function URLs use the API Gateway v2 response shape; we always return the structured form, never a bare string. */
export type FunctionUrlResult = APIGatewayProxyStructuredResultV2;

/** Builds a web-standard Request from a Function URL event. */
export function toWebRequest(event: LambdaFunctionURLEvent): Request {
  const method = event.requestContext.http.method;
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  const hasBody = method !== 'GET' && method !== 'HEAD' && event.body !== undefined;
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, 'base64').toString('utf8') : event.body) : undefined;
  return new Request(url, { method, headers, body });
}

/** Converts a web-standard Response into a Function URL result. MCP responses are JSON text, never binary. */
export async function toLambdaResult(response: Response): Promise<FunctionUrlResult> {
  const text = await response.text();
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    ...(text ? { body: text } : {}),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

/** Reads settings and the bearer token (an SSM SecureString) once per Lambda instance. */
async function loadConfig(): Promise<McpHttpConfig> {
  const parameter = await new SSMClient({}).send(
    new GetParameterCommand({ Name: requiredEnv('FARMASSIST_TOKEN_PARAMETER'), WithDecryption: true }),
  );
  const token = parameter.Parameter?.Value;
  if (!token || token.length < 32) throw new Error('The bearer token parameter is empty or shorter than 32 characters');

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    apiTokens: [{ token, farmId: requiredEnv('FARMASSIST_DEMO_FARM_ID'), clientId: 'demo-client' }],
    deps: { ledger: new DynamoLedgerRepository(client, requiredEnv('FARMASSIST_TABLE_NAME')), now: () => new Date() },
  };
}

let configPromise: Promise<McpHttpConfig> | undefined;
function getConfig(): Promise<McpHttpConfig> {
  configPromise ??= loadConfig().catch((error: unknown) => {
    configPromise = undefined; // retry on the next invocation instead of caching the failure
    throw error;
  });
  return configPromise;
}

const plainText = (statusCode: number, body: string): FunctionUrlResult => ({
  statusCode,
  headers: { 'Content-Type': 'text/plain' },
  body,
});

export async function handler(event: LambdaFunctionURLEvent): Promise<FunctionUrlResult> {
  const started = Date.now();
  let result: FunctionUrlResult;
  try {
    if (event.rawPath !== MCP_PATH) {
      result = plainText(404, `Not found. The MCP endpoint is ${MCP_PATH}`);
    } else {
      result = await toLambdaResult(await handleMcpRequest(toWebRequest(event), await getConfig()));
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Unhandled error in MCP handler', error: error instanceof Error ? error.message : String(error) }));
    result = plainText(500, 'Internal server error');
  }
  // One access-log line per request. Bodies are never logged: they contain farm data.
  console.log(
    JSON.stringify({
      level: 'info',
      requestId: event.requestContext.requestId,
      method: event.requestContext.http.method,
      path: event.rawPath,
      status: result.statusCode,
      durationMs: Date.now() - started,
    }),
  );
  return result;
}
