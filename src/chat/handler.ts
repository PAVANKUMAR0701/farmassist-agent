/**
 * AWS Lambda entry point for the hosted chat backend and web client (Function URL, payload format 2.0).
 * Settings come from environment variables set by template.yaml; the MCP token is read from SSM once per instance.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { FarmMcpClient } from '../agent/mcp-client.js';
import { createAgentModelFromEnv } from '../agent/model.js';
import { createVisionModelFromEnv } from '../agent/photo-help.js';
import { NOVA_EMBEDDINGS_REGION, NovaMultimodalEmbedder } from '../knowledge/nova-embedder.js';
import { createRetriever, type VectorIndex } from '../knowledge/retrieval.js';
import vectorIndex from '../knowledge/vector-index.json' with { type: 'json' };
import { createBedrockClientFromEnv } from '../services/bedrock-client.js';
import { toLambdaResult, toWebRequest, type FunctionUrlResult } from '../lambda/function-url.js';
import { handleChatRequest, type ChatAppDeps } from './app.js';
import { CognitoAuthenticator } from './auth.js';
import { DynamoConversationStore } from './conversations.js';
import { S3PhotoStore } from './photos.js';
import { WEB_ASSETS } from './web-assets.generated.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

async function loadDeps(): Promise<ChatAppDeps> {
  const parameter = await new SSMClient({}).send(
    new GetParameterCommand({ Name: requiredEnv('FARMASSIST_TOKEN_PARAMETER'), WithDecryption: true }),
  );
  const mcpToken = parameter.Parameter?.Value;
  if (!mcpToken) throw new Error('The MCP token parameter is empty');

  // The MCP token belongs to one farm (see src/auth/bearer.ts), so only users of that farm get a connection.
  const mcpFarmId = requiredEnv('FARMASSIST_DEMO_FARM_ID');
  const mcpUrl = requiredEnv('FARMASSIST_MCP_URL');
  let mcpClient: FarmMcpClient | undefined; // reused by every request this instance serves
  const region = process.env.AWS_REGION ?? 'ap-south-1';
  const clientId = requiredEnv('USER_POOL_CLIENT_ID');

  return {
    auth: new CognitoAuthenticator(requiredEnv('USER_POOL_ID'), clientId),
    conversations: new DynamoConversationStore(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
      requiredEnv('FARMASSIST_TABLE_NAME'),
    ),
    toolsFor: (farmId) => (farmId === mcpFarmId ? (mcpClient ??= new FarmMcpClient({ url: mcpUrl, token: mcpToken })) : undefined),
    model: createAgentModelFromEnv(),
    vision: createVisionModelFromEnv(),
    // Embeddings only when switched on (KNOWLEDGE_EMBEDDINGS=nova) and an index was built; keyword search otherwise.
    retriever: createRetriever(
      vectorIndex as VectorIndex,
      process.env.KNOWLEDGE_EMBEDDINGS === 'nova' ? new NovaMultimodalEmbedder(createBedrockClientFromEnv({ ...process.env, BEDROCK_REGION: NOVA_EMBEDDINGS_REGION }, 'farmassist-embeddings')) : undefined,
    ),
    photos: process.env.PHOTO_BUCKET ? new S3PhotoStore(new S3Client({}), process.env.PHOTO_BUCKET) : undefined,
    assets: WEB_ASSETS,
    publicConfig: { auth: 'cognito', region, userPoolClientId: clientId },
  };
}

let depsPromise: Promise<ChatAppDeps> | undefined;
function getDeps(): Promise<ChatAppDeps> {
  depsPromise ??= loadDeps().catch((error: unknown) => {
    depsPromise = undefined; // retry on the next invocation instead of caching the failure
    throw error;
  });
  return depsPromise;
}

export async function handler(event: LambdaFunctionURLEvent): Promise<FunctionUrlResult> {
  const started = Date.now();
  let result: FunctionUrlResult;
  try {
    result = await toLambdaResult(await handleChatRequest(toWebRequest(event), await getDeps()));
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Unhandled error in chat handler', error: error instanceof Error ? error.message : String(error) }));
    result = { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Internal server error' }) };
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
