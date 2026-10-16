/**
 * Finds the reference notes that match what a farmer describes or what a photo shows.
 *
 * - KeywordRetriever (BM25) works with no model at all, so photo help never depends on embeddings.
 * - VectorRetriever uses an Embedder (e.g. Amazon Nova Multimodal Embeddings) and a small in-memory index:
 *   the corpus has a few dozen notes, so a vector database would add cost and nothing else.
 * - HybridRetriever fuses both rankings (reciprocal rank fusion).
 * Embeddings help find similar cases; they do not diagnose anything.
 */
import { REFERENCE_NOTES, type ReferenceNote } from './corpus.js';

export interface RetrievalQuery {
  text?: string;
  image?: { bytes: Uint8Array; format: 'jpeg' | 'png' | 'webp' };
  subject?: 'crop' | 'animal';
}

export interface RetrievedNote {
  note: ReferenceNote;
  score: number;
}

export interface Retriever {
  readonly name: string;
  search(query: RetrievalQuery, k?: number): Promise<RetrievedNote[]>;
}

// Includes common verbs ("show", "look", "can"): they match note sentences without saying anything about the problem.
const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were with my our your they there their very some show shows see seen look looks can may often also will more most please what how why when which'.split(' '),
);
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

const noteText = (n: ReferenceNote) => `${n.title} ${n.title} ${n.appliesTo.join(' ')} ${n.signs} ${n.keywords.join(' ')} ${n.keywords.join(' ')}`;

export class KeywordRetriever implements Retriever {
  readonly name = 'keyword (BM25)';
  private readonly docs: Array<{ note: ReferenceNote; tf: Map<string, number>; length: number }>;
  private readonly idf = new Map<string, number>();
  private readonly avgLength: number;

  constructor(private readonly notes: readonly ReferenceNote[] = REFERENCE_NOTES) {
    this.docs = notes.map((note) => {
      const t = tokens(noteText(note));
      const tf = new Map<string, number>();
      for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
      return { note, tf, length: t.length };
    });
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
    const df = new Map<string, number>();
    for (const d of this.docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    for (const [w, n] of df) this.idf.set(w, Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5)));
  }

  async search(query: RetrievalQuery, k = 3): Promise<RetrievedNote[]> {
    const q = tokens(query.text ?? '');
    const k1 = 1.2;
    const b = 0.75;
    return this.docs
      .filter((d) => !query.subject || d.note.subject === query.subject)
      .map((d) => ({
        note: d.note,
        score: q.reduce((s, w) => {
          const f = d.tf.get(w) ?? 0;
          return f ? s + (this.idf.get(w) ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avgLength))) : s;
        }, 0),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, k);
  }
}

export interface Embedder {
  readonly modelId: string;
  embedText(text: string, purpose: 'index' | 'query'): Promise<number[]>;
  embedImage(image: { bytes: Uint8Array; format: 'jpeg' | 'png' | 'webp' }, purpose: 'index' | 'query'): Promise<number[]>;
}

/** Note vectors computed once (scripts/build-knowledge-index.ts) with one embedding model. */
export interface VectorIndex {
  modelId: string;
  dimension: number;
  vectors: Record<string, number[]>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class VectorRetriever implements Retriever {
  readonly name: string;
  constructor(
    private readonly embedder: Embedder,
    private readonly index: VectorIndex,
    private readonly notes: readonly ReferenceNote[] = REFERENCE_NOTES,
  ) {
    if (index.modelId !== embedder.modelId) throw new Error(`index was built with ${index.modelId}, not ${embedder.modelId}`);
    this.name = `vector (${embedder.modelId})`;
  }

  async search(query: RetrievalQuery, k = 3): Promise<RetrievedNote[]> {
    const vectors: number[][] = [];
    if (query.text) vectors.push(await this.embedder.embedText(query.text, 'query'));
    if (query.image) vectors.push(await this.embedder.embedImage(query.image, 'query'));
    if (vectors.length === 0) return [];
    return this.notes
      .filter((n) => (!query.subject || n.subject === query.subject) && this.index.vectors[n.id])
      .map((note) => ({ note, score: Math.max(...vectors.map((v) => cosine(v, this.index.vectors[note.id]!))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** Reciprocal rank fusion of several retrievers: robust when one of them is weak for a query. */
export class HybridRetriever implements Retriever {
  readonly name: string;
  constructor(private readonly parts: Retriever[]) {
    this.name = `hybrid (${parts.map((p) => p.name).join(' + ')})`;
  }

  async search(query: RetrievalQuery, k = 3): Promise<RetrievedNote[]> {
    const lists = await Promise.all(this.parts.map((p) => p.search(query, 10).catch(() => [] as RetrievedNote[])));
    const fused = new Map<string, RetrievedNote>();
    for (const list of lists) {
      list.forEach((r, rank) => {
        const prev = fused.get(r.note.id);
        fused.set(r.note.id, { note: r.note, score: (prev?.score ?? 0) + 1 / (60 + rank + 1) });
      });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}
