import { describe, it, expect, vi } from 'vitest';
vi.mock('ai', () => ({ embedMany: vi.fn(), generateText: vi.fn() }));
import { embedMany, generateText } from 'ai';
import { configuredEmbeddings } from '../src/retrieval/embeddings.js';
import { configuredTextExtractor } from '../src/retrieval/extraction.js';
import { plainText } from '../src/retrieval/text.js';
import { validateConnectionConfiguration } from '../src/connections/catalog.js';
describe('provider isolation and configuration', () => {
  it('requires explicit model configuration and prevents SDK errors from exposing credentials or source input', async () => {
    expect(configuredEmbeddings()).toBeUndefined();
    expect(configuredTextExtractor()).toBeUndefined();
    vi.mocked(embedMany).mockRejectedValueOnce(
      new Error('authorization: private-fixture-token; secret source text'),
    );
    await expect(
      configuredEmbeddings('fixture/embeddings')!.embed(
        ['Private input'],
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_FAILED',
      message: expect.not.stringContaining('private-fixture-token'),
    });
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error('request headers contain private-fixture-token'),
    );
    await expect(
      configuredTextExtractor('fixture/vision')!.extract({
        data: Buffer.from('file'),
        contentType: 'application/pdf',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toMatchObject({
      code: 'OCR_EXTRACTION_FAILED',
      message: expect.not.stringContaining('private-fixture-token'),
    });
  });
  it('does not send unknown UTF-8 file bodies to OCR and rejects binary controls', () => {
    expect(plainText(Buffer.from('नमस्ते UTF-8'), 'application/octet-stream')).toBe('नमस्ते UTF-8');
    expect(plainText(Buffer.from([0, 1, 2]), 'application/octet-stream')).toBeNull();
    expect(plainText(Buffer.from('PDF bytes'), 'application/pdf')).toBeNull();
  });
  it('never stores database URL credentials or secret column selectors as public configuration', () => {
    expect(
      validateConnectionConfiguration('database', {
        endpoint: 'https://user:private-password@proxy.test',
        query: 'approved_query',
      }),
    ).toBe(false);
    expect(
      validateConnectionConfiguration('supabase', {
        projectRef: 'a'.repeat(20),
        table: 'records',
        columns: 'id,password_hash',
      }),
    ).toBe(false);
    expect(
      validateConnectionConfiguration('database', {
        endpoint: 'https://proxy.test/v1',
        query: 'approved_query',
      }),
    ).toBe(true);
  });
});
