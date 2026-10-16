/**
 * Amazon Nova Multimodal Embeddings through Bedrock (us-east-1 only as of 2026-10). One model embeds text and
 * images into the same space, so a photo can be matched against written reference notes.
 *
 * Request shape per the Bedrock Nova embeddings documentation; to be confirmed with a live call once the
 * Bedrock account allows the model (scripts/build-knowledge-index.ts fails loudly if it does not match).
 */
import { InvokeModelCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Embedder } from './retrieval.js';

export const NOVA_EMBEDDINGS_MODEL_ID = 'amazon.nova-2-multimodal-embeddings-v1:0';
export const NOVA_EMBEDDINGS_REGION = 'us-east-1';

export class NovaMultimodalEmbedder implements Embedder {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId = NOVA_EMBEDDINGS_MODEL_ID,
    private readonly dimension = 1024,
  ) {}

  private async embed(content: Record<string, unknown>, purpose: 'index' | 'query'): Promise<number[]> {
    const body = {
      taskType: 'SINGLE_EMBEDDING',
      singleEmbeddingParams: { embeddingPurpose: purpose === 'index' ? 'GENERIC_INDEX' : 'GENERIC_RETRIEVAL', embeddingDimension: this.dimension, ...content },
    };
    const response = await this.client.send(
      new InvokeModelCommand({ modelId: this.modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embeddings?: Array<{ embedding?: number[] }> };
    const vector = parsed.embeddings?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dimension) throw new Error(`Unexpected embeddings response from ${this.modelId}`);
    return vector;
  }

  embedText(text: string, purpose: 'index' | 'query'): Promise<number[]> {
    return this.embed({ text: { truncationMode: 'END', value: text } }, purpose);
  }

  embedImage(image: { bytes: Uint8Array; format: 'jpeg' | 'png' | 'webp' }, purpose: 'index' | 'query'): Promise<number[]> {
    return this.embed({ image: { format: image.format, source: { bytes: Buffer.from(image.bytes).toString('base64') } } }, purpose);
  }
}
