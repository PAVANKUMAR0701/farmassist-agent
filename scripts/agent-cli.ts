/**
 * Talks to a FarmAssist MCP server through the agent, one conversation per run.
 *
 *   npm run agent -- "spent 2500 on feed" "no, it was 900" "today's summary"
 *
 * Settings (environment or .env.local):
 *   FARMASSIST_MCP_URL     MCP endpoint (default http://127.0.0.1:3000/mcp)
 *   FARMASSIST_API_TOKEN   bearer token for that endpoint
 *   AGENT_MODEL_ID         optional Bedrock model, e.g. apac.amazon.nova-lite-v1:0; without it the
 *                          deterministic fallback handles every message
 *   BEDROCK_AWS_PROFILE    optional named profile for the Bedrock account (local runs only)
 */
import { existsSync } from 'node:fs';
import { FarmAgent } from '../src/agent/agent.js';
import { FarmMcpClient } from '../src/agent/mcp-client.js';
import { createAgentModelFromEnv } from '../src/agent/model.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const url = process.env.FARMASSIST_MCP_URL ?? 'http://127.0.0.1:3000/mcp';
const token = process.env.FARMASSIST_API_TOKEN;
const messages = process.argv.slice(2);
if (!token || messages.length === 0) {
  console.error('Usage: npm run agent -- "<message>" ["<message>" ...]   (FARMASSIST_API_TOKEN must be set)');
  process.exit(1);
}

const tools = new FarmMcpClient({ url, token });
const model = createAgentModelFromEnv();
const agent = new FarmAgent({ tools, model });
console.log(`MCP: ${url}\nModel: ${model ? model.modelId : 'none (deterministic fallback)'}\n`);

for (const message of messages) {
  const started = Date.now();
  const turn = await agent.handle(message);
  console.log(`> ${message}`);
  for (const call of turn.toolCalls) {
    console.log(`  [tool] ${call.name} ${JSON.stringify(call.args)} -> ${call.result.isError ? 'ERROR' : 'ok'}`);
  }
  if (turn.modelError) console.log(`  [model failed] ${turn.modelError.slice(0, 200)}`);
  console.log(`  [${turn.mode}${turn.numberCheck ? `, numbers ${turn.numberCheck}` : ''}, ${Date.now() - started} ms] ${turn.reply}\n`);
}
await tools.close();
