/**
 * Embeds every reference note once with Amazon Nova Multimodal Embeddings and writes
 * src/knowledge/vector-index.json (bundled with the chat Lambda; a few dozen vectors need no database).
 *
 *   BEDROCK_AWS_PROFILE=M80PocBedrockKeys npm run build-knowledge-index
 *
 * Cost: one embedding call per note (13 today), a fraction of a cent.
 */
import { writeFileSync } from 'node:fs';
import { REFERENCE_NOTES } from '../src/knowledge/corpus.js';
import { NOVA_EMBEDDINGS_REGION, NovaMultimodalEmbedder } from '../src/knowledge/nova-embedder.js';
import type { VectorIndex } from '../src/knowledge/retrieval.js';
import { createBedrockClientFromEnv } from '../src/services/bedrock-client.js';

const embedder = new NovaMultimodalEmbedder(createBedrockClientFromEnv({ ...process.env, BEDROCK_REGION: NOVA_EMBEDDINGS_REGION }, 'farmassist-index-build'));
const index: VectorIndex = { modelId: embedder.modelId, dimension: 1024, vectors: {} };
for (const note of REFERENCE_NOTES) {
  index.vectors[note.id] = await embedder.embedText(`${note.title}. ${note.appliesTo.join(', ')}. ${note.signs} ${note.keywords.join(', ')}.`, 'index');
  process.stdout.write('.');
}
writeFileSync('src/knowledge/vector-index.json', `${JSON.stringify(index)}\n`);
console.log(`\nWrote ${Object.keys(index.vectors).length} vectors from ${embedder.modelId}.`);
