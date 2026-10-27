import { embeddingModel } from '../lib/model-provider.js';
import { embedMany } from 'ai';
import { AppError } from '../lib/errors.js';
import type { Embeddings } from './service.js';
export function configuredEmbeddings(model?: string): Embeddings | undefined {
  if (!model) return undefined;
  if (!/^[a-z0-9_-]+\/[a-z0-9._-]+$/i.test(model))
    throw new Error('RETRIEVAL_EMBEDDING_MODEL must be a provider/model identifier.');
  return {
    model,
    async embed(values, signal) {
      try {
        const result = await embedMany({
          model: embeddingModel(model),
          values,
          maxRetries: 0,
          maxParallelCalls: 1,
          abortSignal: signal,
        });
        return result.embeddings;
      } catch {
        throw new AppError(
          503,
          'EMBEDDING_PROVIDER_FAILED',
          'The embedding provider could not complete this request. No provider details were retained.',
        );
      }
    },
  };
}
