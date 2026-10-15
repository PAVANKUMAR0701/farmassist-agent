import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import type { WeeklyFacts } from '../domain/weekly-facts.js';

/** Turns verified weekly facts into a short explanation. The output is always checked by the number guard. */
export interface InsightNarrator {
  readonly modelId: string;
  /** `feedback` lists problems with a previous draft, for a retry. */
  narrate(facts: WeeklyFacts, feedback?: string): Promise<string>;
}

export const NARRATOR_SYSTEM_PROMPT = [
  'You explain a small Indian farm\'s weekly expense records to the farmer in plain, friendly English.',
  'You receive a JSON object of facts that were calculated by software. Write 2 to 4 short sentences, no headings, no lists, no markdown.',
  'Rules:',
  '- Use only numbers that appear in the facts. For money, copy the *Display strings exactly (for example ₹2,650.25). Never add, subtract, multiply, average, project or round numbers yourself.',
  '- Percentages may only come from sharePercent or changePercent, written with %.',
  '- Do not mention any dates.',
  '- If "change" is missing, say there is no earlier week to compare with. If sufficientData is false, say there are too few records to see a pattern.',
  '- Describe what happened only. Do not give financial, veterinary or farming advice and do not guess reasons.',
].join('\n');

export class BedrockInsightNarrator implements InsightNarrator {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId: string,
  ) {}

  async narrate(facts: WeeklyFacts, feedback?: string): Promise<string> {
    const prompt = `Facts:\n${JSON.stringify(facts)}${feedback ? `\n\nYour previous draft was rejected: ${feedback} Write it again following the rules.` : ''}`;
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: NARRATOR_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0.2 },
      }),
    );
    const text = (response.output?.message?.content ?? [])
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error(`Bedrock returned no text (stopReason: ${response.stopReason ?? 'unknown'})`);
    return text;
  }
}

/**
 * Builds the narrator from environment variables, or returns undefined when Bedrock is not configured
 * (weekly_insights then uses its template narration).
 *
 *   BEDROCK_MODEL_ID     model or inference profile id; required to enable Bedrock
 *   BEDROCK_REGION       defaults to AWS_REGION, then ap-south-1
 *   BEDROCK_ROLE_ARN     optional: assume this role first (Bedrock in another AWS account)
 *   BEDROCK_AWS_PROFILE  optional, local development only: use this named profile for Bedrock calls
 */
export function createNarratorFromEnv(env: NodeJS.ProcessEnv = process.env): InsightNarrator | undefined {
  const modelId = env.BEDROCK_MODEL_ID;
  if (!modelId) return undefined;
  const region = env.BEDROCK_REGION || env.AWS_REGION || 'ap-south-1';
  const credentials = env.BEDROCK_ROLE_ARN
    ? fromTemporaryCredentials({
        params: { RoleArn: env.BEDROCK_ROLE_ARN, RoleSessionName: 'farmassist-insights', DurationSeconds: 900 },
        clientConfig: { region },
      })
    : env.BEDROCK_AWS_PROFILE
      ? fromIni({ profile: env.BEDROCK_AWS_PROFILE })
      : undefined;
  return new BedrockInsightNarrator(new BedrockRuntimeClient({ region, ...(credentials ? { credentials } : {}) }), modelId);
}
