/**
 * Converts between Lambda Function URL events (payload format 2.0) and web-standard Request/Response,
 * so request handling can be written once and run both in Lambda and in local Node servers.
 */
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

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
