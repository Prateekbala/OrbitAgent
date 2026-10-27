import { describe, expect, it } from 'vitest';
import { validateRemoteInput } from '../src/developer/mcp-validation.js';
describe('untrusted MCP schema isolation', () => {
  it('rejects expensive schema evaluation without blocking the API event loop', async () => {
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 20);
    try {
      await expect(
        validateRemoteInput({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(1000) + '!'),
      ).rejects.toHaveProperty('code', 'MCP_INPUT_INVALID');
      expect(responsive).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });
});
