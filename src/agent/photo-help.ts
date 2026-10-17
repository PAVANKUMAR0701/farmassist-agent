/**
 * Photo help for sick animals and crop problems.
 *
 * The vision model only *describes what it can see* (structured JSON). Advice comes from the curated reference
 * notes, matched by the retriever and put together by code, so the farmer never gets a made-up treatment.
 * The answer always says it is not a diagnosis, and deterministic rules escalate urgent signs and diseases
 * that must be reported.
 */
import { ConverseCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import type { ReferenceNote } from '../knowledge/corpus.js';
import type { Retriever } from '../knowledge/retrieval.js';
import { createBedrockClientFromEnv } from '../services/bedrock-client.js';

export type ImageFormat = 'jpeg' | 'png' | 'webp';
export interface Photo {
  bytes: Uint8Array;
  format: ImageFormat;
}

export const observationSchema = z.object({
  subject: z.enum(['crop', 'animal', 'other', 'unclear']).catch('unclear'),
  what: z.string().max(120).catch(''),
  visibleSigns: z.array(z.string().max(160)).max(8).catch([]),
  urgentSigns: z.array(z.string().max(160)).max(5).catch([]),
  photoQuality: z.enum(['good', 'poor']).catch('poor'),
  confidence: z.enum(['low', 'medium', 'high']).catch('low'),
});
export type Observation = z.infer<typeof observationSchema>;

export interface VisionModel {
  readonly modelId: string;
  /** Describes the photo as an Observation. Must never be asked for a diagnosis. */
  observe(photo: Photo, farmerNote?: string): Promise<Observation>;
}

export const VISION_PROMPT = [
  'You look at one photo from a small Indian farm: a crop or a farm animal.',
  'Describe only what you can actually see. Do not name a disease, do not diagnose and do not suggest treatment.',
  'Reply with JSON only, no other text, in exactly this shape:',
  '{"subject": "crop" | "animal" | "other" | "unclear", "what": "which crop or animal and which part is shown", ',
  '"visibleSigns": ["each thing you see, in plain words: its colour, shape, size and where it is"], ',
  '"urgentSigns": ["only signs you can see that need help at once (for an animal: lying down and unable to rise, heavy bleeding, a very swollen belly; for a crop: many plants dead)"], ',
  '"photoQuality": "good" | "poor", "confidence": "low" | "medium" | "high"}',
  'If the photo shows nothing unusual, say so in visibleSigns. Never copy wording from these instructions into your answer.',
].join('\n');

/** Pulls the first JSON object out of a reply (models sometimes wrap it in text or code fences). */
export function parseObservation(text: string): Observation {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let raw: unknown = {};
  try {
    raw = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {};
  } catch {
    raw = {};
  }
  return observationSchema.parse(raw && typeof raw === 'object' ? raw : {});
}

export class BedrockVisionModel implements VisionModel {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId: string,
  ) {}

  async observe(photo: Photo, farmerNote?: string): Promise<Observation> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: VISION_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [
              { image: { format: photo.format, source: { bytes: photo.bytes } } },
              { text: farmerNote ? `The farmer says: "${farmerNote.slice(0, 300)}"` : 'Describe this photo.' },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 400, temperature: 0 },
      }),
    );
    const text = (response.output?.message?.content ?? []).map((b) => b.text ?? '').join('');
    return parseObservation(text);
  }
}

export function createVisionModelFromEnv(env: NodeJS.ProcessEnv = process.env): VisionModel | undefined {
  const modelId = env.VISION_MODEL_ID || env.AGENT_MODEL_ID; // Nova Lite reads images, so one model serves both
  return modelId ? new BedrockVisionModel(createBedrockClientFromEnv(env, 'farmassist-vision'), modelId) : undefined;
}

export interface PhotoAnswer {
  reply: string;
  observation?: Observation;
  matches: Array<{ id: string; title: string; readMore: string }>;
  /** Show this prominently: urgent signs, or a disease that must be reported. */
  urgent: boolean;
  notifiable: boolean;
  /** The photo could not be judged; the farmer is asked for a better one. */
  needsBetterPhoto: boolean;
}

const NOT_A_DIAGNOSIS = 'This is general information from a photo, not a diagnosis.';
const join = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Keyword scores below this mean the notes do not really match what was seen. */
export const MIN_MATCH_SCORE = 2;

/** Puts the answer together from the observation and the matched notes (no model involved). */
export function composeAnswer(observation: Observation | undefined, matches: Array<{ note: ReferenceNote; score: number }>, opts: { keywordScores?: boolean } = {}): PhotoAnswer {
  const good = matches.filter((m) => !opts.keywordScores || m.score >= MIN_MATCH_SCORE);
  const urgentSigns = observation?.urgentSigns ?? [];
  const base = { observation, matches: good.slice(0, 2).map((m) => ({ id: m.note.id, title: m.note.title, readMore: m.note.readMore })) };

  if (!observation || observation.subject === 'unclear' || observation.subject === 'other' || (observation.photoQuality === 'poor' && observation.visibleSigns.length === 0)) {
    return {
      ...base,
      matches: [],
      reply: 'I cannot see the problem clearly in this photo. Please take a closer photo in daylight of the affected leaves or the affected part of the animal, and tell me what you have noticed.',
      urgent: urgentSigns.length > 0,
      notifiable: false,
      needsBetterPhoto: true,
    };
  }

  const lines: string[] = [];
  if (urgentSigns.length) lines.push(`This looks urgent: ${join(urgentSigns)}. Call the ${observation.subject === 'animal' ? 'veterinarian' : 'agriculture officer'} now.`);
  if (observation.visibleSigns.length) lines.push(`What I can see: ${join(observation.visibleSigns)}.`);

  const top = good[0];
  if (!top) {
    lines.push(
      `I could not match this to a problem I have notes on. Please show it to the ${observation.subject === 'animal' ? 'veterinarian' : 'agriculture officer or Krishi Vigyan Kendra'}.`,
    );
  } else {
    const second = good[1] && good[1].note.id !== top.note.id ? good[1] : undefined;
    lines.push(`This can look like ${top.note.title}${second ? `, or ${second.note.title}` : ''}. I cannot be sure from a photo.`);
    // Reportable diseases get a clear "today" line, unless the note already says so in its own words.
    if (top.note.notifiable && !/report|notifiable/i.test(top.note.escalate)) {
      lines.push(`Important: ${top.note.title} spreads fast and must be reported. Call the veterinarian or government veterinary hospital today.`);
    }
    lines.push(`What you can do now: ${top.note.firstSteps}`);
    lines.push(top.note.escalate);
    lines.push(`Read more: ${top.note.readMore}.`);
  }
  lines.push(NOT_A_DIAGNOSIS);
  // One part per line: easier to read on a phone (the chat bubble keeps the line breaks).
  return { ...base, reply: lines.join('\n'), urgent: urgentSigns.length > 0 || !!top?.note.notifiable, notifiable: !!top?.note.notifiable, needsBetterPhoto: false };
}

/**
 * When the photo or the farmer names the crop or animal ("paddy", "buffalo"), notes for other crops and
 * animals are left out (seen live: ragi blast offered for a paddy photo). If none would remain, keeps all.
 */
export function forTheSameCropOrAnimal<T extends { note: ReferenceNote }>(matches: T[], description: string): T[] {
  const words = description.toLowerCase();
  const named = new Set(matches.flatMap((m) => m.note.appliesTo).filter((a) => a !== 'any crop' && new RegExp(`\\b${a}\\b`).test(words)));
  if (named.size === 0) return matches;
  const kept = matches.filter((m) => m.note.appliesTo.some((a) => a === 'any crop' || named.has(a)));
  return kept.length ? kept : matches;
}

/** MIN_MATCH_SCORE is on the BM25 scale; fused (hybrid) scores are tiny by design, so it only applies to keyword search. */
function usesKeywordScores(retriever: Retriever): boolean {
  return retriever.name.startsWith('keyword');
}

/** Observe, retrieve, answer. If the vision model fails, the farmer's own words still find notes. */
export async function photoHelp(deps: { vision?: VisionModel | undefined; retriever: Retriever }, photo: Photo, farmerNote?: string, subjectHint?: 'crop' | 'animal'): Promise<PhotoAnswer> {
  let observation: Observation | undefined;
  try {
    observation = deps.vision ? await deps.vision.observe(photo, farmerNote) : undefined;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Vision model failed', error: error instanceof Error ? error.name : 'Unknown' }));
  }
  if (!observation && farmerNote) {
    // No usable model answer: fall back to what the farmer wrote, and say the photo was not read.
    const matches = await deps.retriever.search({ text: farmerNote, ...(subjectHint ? { subject: subjectHint } : {}) }, 2);
    const answer = composeAnswer({ subject: subjectHint ?? 'crop', what: '', visibleSigns: [], urgentSigns: [], photoQuality: 'good', confidence: 'low' }, matches, {
      keywordScores: usesKeywordScores(deps.retriever),
    });
    return { ...answer, reply: `I could not look at the photo right now, so this is based only on what you wrote. ${answer.reply}` };
  }
  if (!observation || observation.subject === 'unclear' || observation.subject === 'other') return composeAnswer(observation, []);
  const subject = observation.subject === 'animal' || observation.subject === 'crop' ? observation.subject : subjectHint;
  const query = [farmerNote, observation.what, ...observation.visibleSigns].filter(Boolean).join('. ');
  const found = await deps.retriever.search({ text: query, image: photo, ...(subject ? { subject } : {}) }, 4);
  return composeAnswer(observation, forTheSameCropOrAnimal(found, `${farmerNote ?? ''} ${observation.what}`).slice(0, 2), {
    keywordScores: usesKeywordScores(deps.retriever),
  });
}
