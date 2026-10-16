import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { BedrockAgentModel, createAgentModelFromEnv } from '../../src/agent/model.js';

const bedrock = mockClient(BedrockRuntimeClient);
beforeEach(() => bedrock.reset());

describe('BedrockAgentModel', () => {
  const model = new BedrockAgentModel(new BedrockRuntimeClient({ region: 'ap-south-1' }), 'apac.amazon.nova-lite-v1:0');

  it('maps messages, tool results and tool specs to the Converse API', async () => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' });
    await model.respond({
      system: 'rules',
      tools: [{ name: 'record_expense', description: 'Saves an expense', inputSchema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'spent 2500 on feed' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'record_expense', input: { amountRupees: 2500 } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', text: 'bad category', isError: true }] },
      ],
    });

    const input = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.modelId).toBe('apac.amazon.nova-lite-v1:0');
    expect(input.system).toEqual([{ text: 'rules' }]);
    expect(input.inferenceConfig).toMatchObject({ temperature: 0 });
    expect(input.toolConfig!.tools![0]).toEqual({
      toolSpec: { name: 'record_expense', description: 'Saves an expense', inputSchema: { json: { type: 'object', properties: {} } } },
    });
    expect(input.messages![1]!.content![0]).toEqual({ toolUse: { toolUseId: 't1', name: 'record_expense', input: { amountRupees: 2500 } } });
    expect(input.messages![2]!.content![0]).toEqual({ toolResult: { toolUseId: 't1', content: [{ text: 'bad category' }], status: 'error' } });
  });

  it('reads tool-use requests and text from the reply', async () => {
    bedrock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Recording it.' }, { toolUse: { toolUseId: 'abc', name: 'record_expense', input: { amountRupees: 800, category: 'medicine' } } }],
        },
      },
      stopReason: 'tool_use',
    });
    const reply = await model.respond({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] });
    expect(reply).toEqual({
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Recording it.' },
        { type: 'tool_use', id: 'abc', name: 'record_expense', input: { amountRupees: 800, category: 'medicine' } },
      ],
    });
    expect(bedrock.commandCalls(ConverseCommand)[0]!.args[0].input.toolConfig).toBeUndefined();
  });
});

describe('createAgentModelFromEnv', () => {
  it('is off without AGENT_MODEL_ID and uses the configured id otherwise', () => {
    expect(createAgentModelFromEnv({})).toBeUndefined();
    expect(createAgentModelFromEnv({ AGENT_MODEL_ID: 'apac.amazon.nova-micro-v1:0' })?.modelId).toBe('apac.amazon.nova-micro-v1:0');
  });
});
