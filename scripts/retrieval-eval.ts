/**
 * Measures retrieval quality on the labelled queries: how often the right note is first (hit@1) and in the
 * top 3 (hit@3). Always runs the keyword retriever; with --vectors (and a built index) also the vector and
 * hybrid retrievers.
 *
 *   npm run retrieval-eval                     # keyword only, no model needed
 *   BEDROCK_AWS_PROFILE=M80PocBedrockKeys npm run retrieval-eval -- --vectors
 */
import { existsSync, readFileSync } from 'node:fs';
import { RETRIEVAL_QUERIES } from '../src/knowledge/eval-queries.js';
import { NOVA_EMBEDDINGS_REGION, NovaMultimodalEmbedder } from '../src/knowledge/nova-embedder.js';
import { HybridRetriever, KeywordRetriever, VectorRetriever, type Retriever, type VectorIndex } from '../src/knowledge/retrieval.js';
import { createBedrockClientFromEnv } from '../src/services/bedrock-client.js';

const INDEX_FILE = 'src/knowledge/vector-index.json';
const retrievers: Retriever[] = [new KeywordRetriever()];
if (process.argv.includes('--vectors')) {
  if (!existsSync(INDEX_FILE)) throw new Error(`${INDEX_FILE} not found; run npm run build-knowledge-index first`);
  const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as VectorIndex;
  const vector = new VectorRetriever(new NovaMultimodalEmbedder(createBedrockClientFromEnv({ ...process.env, BEDROCK_REGION: NOVA_EMBEDDINGS_REGION }, 'farmassist-retrieval-eval')), index);
  retrievers.push(vector, new HybridRetriever([retrievers[0]!, vector]));
}

for (const retriever of retrievers) {
  let hit1 = 0;
  let hit3 = 0;
  const misses: string[] = [];
  for (const q of RETRIEVAL_QUERIES) {
    const found = (await retriever.search({ text: q.text, subject: q.subject }, 3)).map((r) => r.note.id);
    if (found[0] === q.expected) hit1++;
    if (found.includes(q.expected)) hit3++;
    else misses.push(`"${q.text}" -> ${found.join(', ') || '(nothing)'} (expected ${q.expected})`);
  }
  console.log(`${retriever.name}: hit@1 ${hit1}/${RETRIEVAL_QUERIES.length}, hit@3 ${hit3}/${RETRIEVAL_QUERIES.length}`);
  for (const m of misses) console.log(`  miss: ${m}`);
}
