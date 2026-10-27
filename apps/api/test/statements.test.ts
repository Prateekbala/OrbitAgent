import { describe, expect, it } from 'vitest';
import { statements } from '@ao/database';

describe('SQL migration scripts', () => {
  it('preserves procedural bodies, escaped quotes, identifiers and nested comments', () => {
    const script = `-- semicolon ; in comment
DO $body$ BEGIN RAISE NOTICE 'don''t; split'; END $body$;
/* outer ; /* nested ; */ */ SELECT 'one;two', "a;name";
SELECT $$literal;body$$;`;
    expect(statements(script)).toEqual([
      "-- semicolon ; in comment\nDO $body$ BEGIN RAISE NOTICE 'don''t; split'; END $body$",
      '/* outer ; /* nested ; */ */ SELECT \'one;two\', "a;name"',
      'SELECT $$literal;body$$',
    ]);
  });
  it('rejects unterminated SQL instead of applying a partial migration', () => {
    for (const script of ["SELECT 'broken", 'DO $$ BEGIN;', '/* missing end']) {
      expect(() => statements(script)).toThrow('Unterminated SQL');
    }
  });
});
