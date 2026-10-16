import { describe, expect, it } from 'vitest';
import { REFERENCE_NOTES } from '../../src/knowledge/corpus.js';
import { RETRIEVAL_QUERIES } from '../../src/knowledge/eval-queries.js';
import { cosine, HybridRetriever, KeywordRetriever, tokens, VectorRetriever, type Embedder } from '../../src/knowledge/retrieval.js';

describe('reference notes', () => {
  it('every note says when to get professional help, and notifiable diseases say they must be reported', () => {
    for (const n of REFERENCE_NOTES) {
      expect(n.escalate.length).toBeGreaterThan(20);
      if (n.notifiable) expect(n.escalate).toMatch(/report|notifiable/i);
    }
    expect(new Set(REFERENCE_NOTES.map((n) => n.id)).size).toBe(REFERENCE_NOTES.length);
  });
});

describe('KeywordRetriever', () => {
  it('finds the right note in the top 3 for every labelled query, and first for nearly all', async () => {
    const retriever = new KeywordRetriever();
    let first = 0;
    for (const q of RETRIEVAL_QUERIES) {
      const found = (await retriever.search({ text: q.text, subject: q.subject }, 3)).map((r) => r.note.id);
      expect(found).toContain(q.expected);
      if (found[0] === q.expected) first++;
    }
    expect(first).toBeGreaterThanOrEqual(RETRIEVAL_QUERIES.length - 2);
  });

  it('keeps crop and animal notes apart, and returns nothing for unrelated text', async () => {
    const retriever = new KeywordRetriever();
    expect((await retriever.search({ text: 'swollen udder', subject: 'crop' })).every((r) => r.note.subject === 'crop')).toBe(true);
    expect(await retriever.search({ text: 'please show my expenses for october' })).toEqual([]);
  });

  it('tokens drop stop words and simple plurals', () => {
    expect(tokens('The leaves have brown spots')).toEqual(['leave', 'brown', 'spot']);
  });
});

describe('VectorRetriever and HybridRetriever', () => {
  // A fake embedder: one dimension per known keyword, so results are predictable.
  const vocab = ['udder', 'lumps', 'blast', 'drool'];
  const embed = (t: string) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0));
  const embedder: Embedder = { modelId: 'fake', embedText: async (t) => embed(t), embedImage: async () => embed('lumps') };
  const index = { modelId: 'fake', dimension: 4, vectors: Object.fromEntries(REFERENCE_NOTES.map((n) => [n.id, embed(`${n.title} ${n.signs} ${n.keywords.join(' ')}`)])) };

  it('ranks by cosine similarity, and an image query uses the image embedding', async () => {
    const vector = new VectorRetriever(embedder, index);
    expect((await vector.search({ text: 'her udder looks bad', subject: 'animal' }))[0]!.note.id).toBe('cattle-mastitis');
    expect((await vector.search({ image: { bytes: new Uint8Array([1]), format: 'jpeg' }, subject: 'animal' }))[0]!.note.id).toBe('cattle-lumpy-skin');
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('refuses an index built with a different model', () => {
    expect(() => new VectorRetriever(embedder, { ...index, modelId: 'other' })).toThrow(/built with other/);
  });

  it('hybrid fusion keeps working when one retriever fails', async () => {
    const broken: Embedder = { ...embedder, embedText: async () => Promise.reject(new Error('AccessDenied')) };
    const hybrid = new HybridRetriever([new KeywordRetriever(), new VectorRetriever(broken, index)]);
    expect((await hybrid.search({ text: 'blood in the milk from one teat', subject: 'animal' }))[0]!.note.id).toBe('cattle-mastitis');
  });
});
