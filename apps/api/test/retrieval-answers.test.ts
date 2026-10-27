import { afterEach, describe, expect, it } from 'vitest';
import { scopedDatabase } from '@ao/database';
import { messagingFixture } from './messaging-fixture.js';
import { RetrievalWorker } from '../src/retrieval/worker.js';
import { reserveAnswer } from '../src/retrieval/answer-budget.js';
import type { AnswerSynthesizer } from '../src/retrieval/answers.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => f?.close());
async function setup(synthesize: AnswerSynthesizer['synthesize']) {
  f = await messagingFixture(undefined, undefined, {
    answers: { model: 'fixture/cited-answer', synthesize },
  });
  const channel = await f.channel(),
    message = (
      await f.send(f.owner, channel, 'AnswerEvidence: release verification passed.')
    ).json().id;
  await new RetrievalWorker(f.db).tick();
  return { channel, message };
}
const answer = () =>
  f.call(f.owner, 'POST', '/v1/search/answer', { q: 'AnswerEvidence', answerMode: 'model' });
describe('model-written cited answers', () => {
  it('publishes only source-bound quotes, preserves evidence flags and records no query or generated content', async () => {
    await setup(async ({ evidence }) => {
      expect(Object.keys(evidence[0]!).sort()).toEqual([
        'citation',
        'conflict',
        'excerpt',
        'freshness',
      ]);
      return {
        claims: [
          {
            text: 'Release verification passed.',
            supports: [{ citation: evidence[0]!.citation, quote: 'release verification passed.' }],
          },
        ],
        missingEvidence: true,
        conflictingEvidence: true,
      };
    });
    const result = await answer();
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      answerMode: 'model',
      verification: 'quotes-checked-entailment-unverified',
      indicators: { missingEvidence: true, conflictingEvidence: true },
    });
    expect(result.json().answer).toContain('[1]');
    const rows = await f.db.query('SELECT * FROM retrieval_answer_attempts');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('succeeded');
    expect(JSON.stringify(rows)).not.toContain('AnswerEvidence');
    expect(JSON.stringify(rows)).not.toContain('Release verification');
  });
  it('rejects fabricated citations and quotes without publishing the model output', async () => {
    await setup(async () => ({
      claims: [
        {
          text: 'Untrusted fabricated result',
          supports: [{ citation: '[99]', quote: 'Nonexistent quote' }],
        },
      ],
      missingEvidence: false,
      conflictingEvidence: false,
    }));
    const result = await answer();
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain('Untrusted fabricated result');
  });
  it('rechecks source authority after generation and rejects a corrected source before publication', async () => {
    let message = '';
    ({ message } = await setup(async ({ evidence }) => {
      await f.call(f.owner, 'PATCH', `/v1/messages/${message}`, {
        version: 1,
        body: 'The release failed verification.',
      });
      return {
        claims: [
          {
            text: 'Must never be published',
            supports: [{ citation: evidence[0]!.citation, quote: 'release verification passed.' }],
          },
        ],
        missingEvidence: false,
        conflictingEvidence: false,
      };
    }));
    const result = await answer();
    expect(result.statusCode).toBe(409);
    expect(result.body).not.toContain('Must never be published');
  });
  it('fails closed on provider errors and does not consume inference for missing evidence', async () => {
    let calls = 0;
    await setup(async () => {
      calls++;
      throw new Error('private-provider-credential');
    });
    const missing = await f.call(f.owner, 'POST', '/v1/search/answer', {
      q: 'NoSuchAvailableEvidence',
      answerMode: 'model',
    });
    expect(missing.statusCode, missing.body).toBe(200);
    expect(calls).toBe(0);
    const failed = await answer();
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('private-provider-credential');
  });
  it('reserves concurrent and daily allowances atomically, including failed attempts', async () => {
    f = await messagingFixture();
    const db = scopedDatabase(f.db),
      p = {
        workspaceId: f.ownerBoot.workspace.id,
        membershipId: f.ownerBoot.me.id,
        name: 'Owner',
        kind: 'human' as const,
        role: 'owner' as const,
      };
    const limits = { workspaceDaily: 2, memberDaily: 2, concurrency: 1 };
    const reservations = await Promise.allSettled([
      reserveAnswer(db, p, 'fixture/model', 100, limits),
      reserveAnswer(db, p, 'fixture/model', 100, limits),
    ]);
    expect(reservations.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await f.db.query("UPDATE retrieval_answer_attempts SET state='failed',completed_at=now()");
    await reserveAnswer(db, p, 'fixture/model', 100, limits);
    await f.db.query("UPDATE retrieval_answer_attempts SET state='failed',completed_at=now()");
    await expect(reserveAnswer(db, p, 'fixture/model', 100, limits)).rejects.toMatchObject({
      code: 'ANSWER_USAGE_LIMIT',
    });
  });
});
