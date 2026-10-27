import { performance } from 'node:perf_hooks';
import { workerScope, scopedDatabase, type Database, type Sql } from '@ao/database';
import type { z } from 'zod';
import {
  retrievalQuery,
  answerQuery,
  type RetrievalHit,
  type RetrievalResult,
  type SourceReference,
} from '@ao/contracts/retrieval';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
import { terms, assertVectors, cosine } from './text.js';
import { validateAnswerSupport, type AnswerSynthesizer } from './answers.js';
import { reserveAnswer, defaultAnswerLimits, type AnswerLimits } from './answer-budget.js';
export interface Embeddings {
  readonly model: string;
  embed(values: string[], signal: AbortSignal): Promise<number[][]>;
}
interface Candidate extends Record<string, unknown> {
  kind: RetrievalHit['kind'];
  source_id: string;
  source_version: number;
  title: string;
  body: string;
  ordinal: number;
  freshness: RetrievalHit['freshness'];
  conflict: boolean;
  indexed_at: Date | string;
  rank: number;
  embedding: number[] | null;
  embedding_model: string | null;
}
export async function requireSources(tx: Sql, p: Identity, sources: SourceReference[]) {
  if (p.authVersion !== undefined) {
    const [authority] = await tx.query(
      'SELECT a.auth_version,a.verified,workspace_policy_version($1) policy FROM member_account_authority($1,$2) a',
      [p.workspaceId, p.membershipId],
    );
    if (
      !authority?.verified ||
      Number(authority.auth_version) !== p.authVersion ||
      Number(authority.policy) !== p.policyVersion
    )
      throw new AppError(
        409,
        'AUTHORITY_CHANGED',
        'Account or organization authority changed. Sign in and retrieve fresh context.',
      );
  }
  for (const ref of sources) {
    const [row] = await tx.query(
      'SELECT retrieval_source_visible($1,$2,$3,$4) AND retrieval_source_version($1,$2,$3)=$5 allowed',
      [p.workspaceId, ref.kind, ref.id, p.membershipId, ref.version],
    );
    if (!row?.allowed)
      throw new AppError(
        409,
        'EVIDENCE_UNAVAILABLE',
        'A source changed, expired, or is no longer accessible. Run retrieval again.',
      );
  }
}
export class RetrievalService {
  constructor(
    private db: Database,
    private embeddings?: Embeddings,
    private synthesizer?: AnswerSynthesizer,
    private answerLimits: AnswerLimits = defaultAnswerLimits,
  ) {
    this.db = scopedDatabase(db);
  }
  async search(p: Identity, input: z.infer<typeof retrievalQuery>): Promise<RetrievalResult> {
    const started = performance.now();
    const words = terms(input.q).slice(0, 40);
    if (!words.length)
      throw new AppError(400, 'SEARCH_TERMS_REQUIRED', 'Enter at least one searchable word.');
    const lexical = words.map((word) => '"' + word.replaceAll('"', ' ') + '"').join(' OR ');
    if (input.semantic && !this.embeddings)
      throw new AppError(
        503,
        'EMBEDDINGS_UNAVAILABLE',
        'Semantic retrieval is not configured. Lexical search remains available.',
      );
    const [authority] = await this.db.query(
      'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
      [p.workspaceId],
    );
    const candidates = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      await requireSources(tx, p, []);
      return tx.query<Candidate>(
        `SELECT hydrated.*,candidate.lexical_rank rank FROM retrieval_candidates($1,$2,$3,$4,$5,301) candidate
       CROSS JOIN LATERAL (SELECT c.kind,c.source_id,d.source_version,d.title,c.body,c.ordinal,
        CASE WHEN d.kind='document' AND d.indexed_at<now()-interval '24 hours' THEN 'stale' ELSE d.freshness END freshness,
        d.conflict,d.indexed_at,c.embedding,c.embedding_model
        FROM retrieval_chunks c JOIN retrieval_documents d USING(workspace_id,kind,source_id)
        WHERE c.workspace_id=$1 AND c.kind=candidate.kind AND c.source_id=candidate.source_id AND c.ordinal=candidate.ordinal OFFSET 0) hydrated
       ORDER BY candidate.lexical_rank DESC,hydrated.indexed_at DESC,hydrated.source_id,hydrated.ordinal`,
        [p.workspaceId, lexical, input.kinds ?? null, p.membershipId, input.semantic],
      );
    });
    const selected = candidates.slice(0, 300);
    let vector: number[] | undefined;
    if (input.semantic && this.embeddings) {
      const batch = selected
        .filter((c) => !c.embedding || c.embedding_model !== this.embeddings!.model)
        .slice(0, 32);
      await this.db.transaction((tx) =>
        requireSources(
          tx,
          p,
          batch.map((row) => ({ kind: row.kind, id: row.source_id, version: row.source_version })),
        ),
      );
      const vectors = await this.embeddings.embed(
        [input.q, ...batch.map((c) => c.body)],
        AbortSignal.timeout(15000),
      );
      assertVectors(vectors, batch.length + 1);
      vector = vectors[0]!;
      batch.forEach((candidate, index) => {
        candidate.embedding = vectors[index + 1]!;
        candidate.embedding_model = this.embeddings!.model;
      });
    }
    const ranked = selected
      .map((c) => ({
        c,
        score:
          Number(c.rank) +
          (vector && c.embedding_model === this.embeddings?.model && c.embedding
            ? Math.max(0, cosine(vector, c.embedding))
            : 0),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const chosen = ranked
      .filter(({ c }) => {
        const id = c.kind + ':' + c.source_id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, input.limit);
    const refs = chosen.map(({ c }) => ({
      kind: c.kind,
      id: c.source_id,
      version: c.source_version,
    }));
    const contextId = await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const [current] = await tx.query(
        'SELECT epoch FROM retrieval_authority WHERE workspace_id=$1',
        [p.workspaceId],
      );
      if (String(current?.epoch) !== String(authority?.epoch))
        throw new AppError(
          409,
          'AUTHORITY_CHANGED',
          'Access changed while searching. Run retrieval again.',
        );
      await requireSources(tx, p, refs);
      const [context] = await tx.query(
        'INSERT INTO retrieval_contexts(workspace_id,member_id,credential_id,epoch,sources,auth_version,policy_version) VALUES($1,$2,$3,$4,$5,$6,workspace_policy_version($1)) RETURNING id',
        [
          p.workspaceId,
          p.membershipId,
          p.credentialId ?? null,
          current!.epoch,
          JSON.stringify(refs),
          p.authVersion ?? null,
        ],
      );
      return String(context!.id);
    });
    const items: RetrievalHit[] = chosen.map(({ c, score }, i) => ({
      kind: c.kind,
      id: c.source_id,
      version: c.source_version,
      title: c.title || c.kind,
      excerpt: c.body.slice(0, 1600),
      citation: `[${i + 1}]`,
      score,
      freshness: c.freshness,
      conflict: c.conflict,
      indexedAt: new Date(c.indexed_at).toISOString(),
    }));
    await workerScope(p.workspaceId, () =>
      this.db.query(
        'INSERT INTO retrieval_metrics(workspace_id,duration_ms,candidate_count,result_count,mode) VALUES($1,$2,$3,$4,$5)',
        [
          p.workspaceId,
          Math.round(performance.now() - started),
          selected.length,
          items.length,
          vector ? 'hybrid' : 'lexical',
        ],
      ),
    );
    return {
      items,
      contextId,
      mode: vector ? 'hybrid' : 'lexical',
      truncated: candidates.length > 300,
      indicators: {
        missingEvidence: !items.length,
        staleEvidence: items.some((i) => i.freshness === 'stale'),
        conflictingEvidence: items.some((i) => i.conflict),
      },
    };
  }
  async inspect(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      const [context] = await tx.query(
        'SELECT sources FROM retrieval_contexts WHERE workspace_id=$1 AND id=$2 AND member_id=$3',
        [p.workspaceId, id, p.membershipId],
      );
      if (!context)
        throw new AppError(
          409,
          'CONTEXT_INVALIDATED',
          'This context expired or its audience changed.',
        );
      const sources = context.sources as SourceReference[];
      await requireSources(tx, p, sources);
      return { id, sources };
    });
  }
  async answer(p: Identity, input: z.infer<typeof answerQuery>) {
    if (input.answerMode === 'model' && !this.synthesizer)
      throw new AppError(
        503,
        'ANSWER_MODEL_UNAVAILABLE',
        'Model-written answers are not configured. Extractive answers remain available.',
      );
    const result = await this.search(
      p,
      retrievalQuery.parse({
        q: input.q,
        kinds: input.kinds,
        limit: input.limit,
        semantic: input.semantic,
      }),
    );
    await this.inspect(p, result.contextId);
    if (input.answerMode === 'model' && result.items.length) {
      const evidence: typeof result.items = [];
      const payload = (hits: typeof evidence) =>
        JSON.stringify({
          question: input.q,
          evidence: hits.map(({ citation, excerpt, freshness, conflict }) => ({
            citation,
            excerpt,
            freshness,
            conflict,
          })),
        });
      for (const hit of result.items.slice(0, 12)) {
        if (Buffer.byteLength(payload([...evidence, hit])) > 24000) break;
        evidence.push(hit);
      }
      const attempt = await reserveAnswer(
        this.db,
        p,
        this.synthesizer!.model,
        Buffer.byteLength(payload(evidence)) + 4000,
        this.answerLimits,
      );
      try {
        await this.inspect(p, result.contextId);
        const generated = validateAnswerSupport(
          await this.synthesizer!.synthesize({
            query: input.q,
            evidence: evidence.map(({ citation, excerpt, freshness, conflict }) => ({
              citation,
              excerpt,
              freshness,
              conflict,
            })),
            signal: AbortSignal.timeout(30000),
          }),
          evidence,
        );
        await this.inspect(p, result.contextId);
        await workerScope(p.workspaceId, () =>
          this.db.query(
            "UPDATE retrieval_answer_attempts SET state='succeeded',completed_at=now() WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, attempt],
          ),
        );
        await this.inspect(p, result.contextId);
        return {
          ...result,
          answer:
            generated.claims
              .map(
                (claim) =>
                  claim.text + ' ' + [...new Set(claim.supports.map((s) => s.citation))].join(' '),
              )
              .join('\n\n') ||
            'No supported answer could be established from the accessible evidence.',
          answerMode: 'model' as const,
          support: generated.claims,
          indicators: {
            ...result.indicators,
            missingEvidence:
              result.indicators.missingEvidence ||
              generated.missingEvidence ||
              !generated.claims.length,
            conflictingEvidence:
              result.indicators.conflictingEvidence || generated.conflictingEvidence,
          },
          verification: 'quotes-checked-entailment-unverified' as const,
        };
      } catch (error) {
        await workerScope(p.workspaceId, () =>
          this.db.query(
            "UPDATE retrieval_answer_attempts SET state='failed',completed_at=now() WHERE workspace_id=$1 AND id=$2",
            [p.workspaceId, attempt],
          ),
        );
        if (error instanceof AppError) throw error;
        throw new AppError(
          502,
          'ANSWER_GENERATION_FAILED',
          'The cited answer could not be verified. No generated text was published.',
        );
      }
    }
    return {
      ...result,
      answer: result.items.length
        ? result.items
            .slice(0, 5)
            .map((hit) => `${hit.excerpt} ${hit.citation}`)
            .join('\n\n')
        : 'No accessible evidence was found.',
      answerMode: 'extractive' as const,
    };
  }
}
