import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeWeeklyFacts } from '../../src/domain/weekly-facts.js';
import { BedrockInsightNarrator, createNarratorFromEnv, NARRATOR_SYSTEM_PROMPT } from '../../src/services/insight-narrator.js';

const bedrock = mockClient(BedrockRuntimeClient);
const facts = computeWeeklyFacts({
  week: { from: '2026-10-08', to: '2026-10-14' },
  previousWeek: { from: '2026-10-01', to: '2026-10-07' },
  dayCount: 7,
  expenses: [],
  previousExpenses: [],
  activities: [],
});

beforeEach(() => bedrock.reset());

describe('BedrockInsightNarrator', () => {
  it('sends the facts to the Converse API with the system rules and a low temperature', async () => {
    bedrock
      .on(ConverseCommand)
      .resolves({ output: { message: { role: 'assistant', content: [{ text: ' No spending this week. ' }] } }, stopReason: 'end_turn' });
    const narrator = new BedrockInsightNarrator(new BedrockRuntimeClient({ region: 'ap-south-1' }), 'in.anthropic.claude-haiku-4-5-20251001-v1:0');

    expect(await narrator.narrate(facts)).toBe('No spending this week.');
    const input = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.modelId).toBe('in.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(input.system).toEqual([{ text: NARRATOR_SYSTEM_PROMPT }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 300, temperature: 0.2 });
    expect(input.messages![0]!.content![0]!.text).toContain(JSON.stringify(facts));
  });

  it('includes retry feedback and fails on an empty reply', async () => {
    bedrock.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [] } }, stopReason: 'max_tokens' });
    const narrator = new BedrockInsightNarrator(new BedrockRuntimeClient({ region: 'ap-south-1' }), 'm');
    await expect(narrator.narrate(facts, 'it contained ₹4,000.')).rejects.toThrow('max_tokens');
    expect(bedrock.commandCalls(ConverseCommand)[0]!.args[0].input.messages![0]!.content![0]!.text).toContain('rejected: it contained ₹4,000.');
  });
});

describe('createNarratorFromEnv', () => {
  it('is disabled without BEDROCK_MODEL_ID', () => {
    expect(createNarratorFromEnv({})).toBeUndefined();
  });

  it('uses the model id and region from the environment', async () => {
    const narrator = createNarratorFromEnv({
      BEDROCK_MODEL_ID: 'm1',
      BEDROCK_REGION: 'us-east-1',
      BEDROCK_ROLE_ARN: 'arn:aws:iam::111122223333:role/bedrock',
    });
    expect(narrator?.modelId).toBe('m1');
    const client = (narrator as unknown as { client: BedrockRuntimeClient }).client;
    expect(await client.config.region()).toBe('us-east-1');
  });
});
