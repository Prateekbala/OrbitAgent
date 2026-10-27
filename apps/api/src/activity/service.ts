import type { Database, Sql } from '@ao/database';
import type { Identity } from '../lib/policy.js';
import { requireConversation } from '../lib/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { requirePerson } from '../notifications/service.js';
async function actor(tx: Sql, p: Identity) {
  requirePerson(p);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,58721))', [
    p.workspaceId + ':' + p.membershipId,
  ]);
  const [member] = await tx.query(
    "SELECT id FROM memberships WHERE workspace_id=$1 AND id=$2 AND status='active' AND kind='human' FOR SHARE",
    [p.workspaceId, p.membershipId],
  );
  if (!member) throw new AppError(403, 'FORBIDDEN', 'Active membership is required.');
}
export class ActivityService {
  constructor(private readonly db: Database) {}
  async heartbeat(
    p: Identity,
    session: string,
    input: { clientId: string; revision: number; state: 'active' | 'away' },
  ) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await tx.query(
        'DELETE FROM activity_sessions WHERE workspace_id=$1 AND membership_id=$2 AND expires_at<now()',
        [p.workspaceId, p.membershipId],
      );
      const [live] = await tx.query(
        'SELECT token_hash FROM sessions WHERE workspace_id=$1 AND membership_id=$2 AND token_hash=$3 AND expires_at>now()',
        [p.workspaceId, p.membershipId, session],
      );
      if (!live) throw new AppError(401, 'SESSION_CHANGED', 'Sign in again.');
      const [existing] = await tx.query(
        'SELECT revision FROM activity_sessions WHERE workspace_id=$1 AND membership_id=$2 AND session_hash=$3 AND client_id=$4',
        [p.workspaceId, p.membershipId, session, input.clientId],
      );
      if (!existing) {
        const [count] = await tx.query(
          'SELECT count(*)::int total FROM activity_sessions WHERE workspace_id=$1 AND membership_id=$2 AND expires_at>now()',
          [p.workspaceId, p.membershipId],
        );
        if (Number(count!.total) >= 32)
          throw new AppError(
            429,
            'PRESENCE_CLIENT_LIMIT',
            'Close another workspace tab before connecting.',
          );
      }
      await tx.query(
        `INSERT INTO activity_sessions(workspace_id,membership_id,session_hash,client_id,state,revision,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds')
        ON CONFLICT(workspace_id,membership_id,session_hash,client_id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,expires_at=EXCLUDED.expires_at,
        typing_conversation_id=CASE WHEN EXCLUDED.state='away' THEN NULL ELSE activity_sessions.typing_conversation_id END,
        typing_thread_id=CASE WHEN EXCLUDED.state='away' THEN NULL ELSE activity_sessions.typing_thread_id END,
        typing_expires_at=CASE WHEN EXCLUDED.state='away' THEN NULL ELSE activity_sessions.typing_expires_at END
        WHERE activity_sessions.revision<EXCLUDED.revision`,
        [p.workspaceId, p.membershipId, session, input.clientId, input.state, input.revision],
      );
      return { ok: true };
    });
  }
  async leave(p: Identity, session: string, clientId: string) {
    requirePerson(p);
    await this.db.query(
      'DELETE FROM activity_sessions WHERE workspace_id=$1 AND membership_id=$2 AND session_hash=$3 AND client_id=$4',
      [p.workspaceId, p.membershipId, session, clientId],
    );
    return { ok: true };
  }
  async preference(p: Identity, mode: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await tx.query(
        'INSERT INTO activity_preferences(workspace_id,membership_id,mode) VALUES($1,$2,$3) ON CONFLICT(workspace_id,membership_id) DO UPDATE SET mode=EXCLUDED.mode',
        [p.workspaceId, p.membershipId, mode],
      );
      if (mode !== 'automatic')
        await tx.query(
          'UPDATE activity_sessions SET typing_conversation_id=NULL,typing_thread_id=NULL,typing_expires_at=NULL WHERE workspace_id=$1 AND membership_id=$2',
          [p.workspaceId, p.membershipId],
        );
      return { ok: true };
    });
  }
  async typing(
    p: Identity,
    session: string,
    conversation: string,
    input: { clientId: string; revision: number; threadId?: string | undefined; active: boolean },
  ) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      await requireConversation(tx, p, conversation, true);
      if (input.threadId) {
        const [root] = await tx.query(
          'SELECT id FROM messages WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND thread_id IS NULL',
          [p.workspaceId, conversation, input.threadId],
        );
        if (!root) throw notFound();
      }
      const [client] = await tx.query(
        'SELECT state FROM activity_sessions WHERE workspace_id=$1 AND membership_id=$2 AND session_hash=$3 AND client_id=$4 AND expires_at>now()',
        [p.workspaceId, p.membershipId, session, input.clientId],
      );
      if (!client)
        throw new AppError(
          409,
          'PRESENCE_REQUIRED',
          'Reconnect presence before publishing typing.',
        );
      const [preference] = await tx.query(
        'SELECT mode FROM activity_preferences WHERE workspace_id=$1 AND membership_id=$2',
        [p.workspaceId, p.membershipId],
      );
      const active =
        input.active &&
        client.state === 'active' &&
        (!preference || preference.mode === 'automatic');
      await tx.query(
        `UPDATE activity_sessions SET typing_revision=$5,
        typing_conversation_id=CASE WHEN $8 THEN $6::uuid WHEN typing_conversation_id=$6 AND typing_thread_id IS NOT DISTINCT FROM $7::uuid THEN NULL ELSE typing_conversation_id END,
        typing_thread_id=CASE WHEN $8 THEN $7::uuid WHEN typing_conversation_id=$6 AND typing_thread_id IS NOT DISTINCT FROM $7::uuid THEN NULL ELSE typing_thread_id END,
        typing_expires_at=CASE WHEN $8 THEN now()+interval '8 seconds' WHEN typing_conversation_id=$6 AND typing_thread_id IS NOT DISTINCT FROM $7::uuid THEN NULL ELSE typing_expires_at END
        WHERE workspace_id=$1 AND membership_id=$2 AND session_hash=$3 AND client_id=$4 AND typing_revision<$5`,
        [
          p.workspaceId,
          p.membershipId,
          session,
          input.clientId,
          input.revision,
          conversation,
          input.threadId ?? null,
          active,
        ],
      );
      return { ok: true };
    });
  }
  async snapshot(p: Identity, membershipIds?: string[]) {
    requirePerson(p);
    const [preference] = await this.db.query(
      'SELECT mode FROM activity_preferences WHERE workspace_id=$1 AND membership_id=$2',
      [p.workspaceId, p.membershipId],
    );
    const presence = await this.db.query(
      `SELECT a.membership_id,CASE WHEN COALESCE(pref.mode,'automatic')='away' THEN 'away' WHEN bool_or(a.state='active') THEN 'online' ELSE 'away' END state
      FROM activity_sessions a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id AND m.status='active' AND m.kind='human'
      JOIN sessions s ON s.workspace_id=a.workspace_id AND s.membership_id=a.membership_id AND s.token_hash=a.session_hash AND s.expires_at>now()
      LEFT JOIN activity_preferences pref ON pref.workspace_id=a.workspace_id AND pref.membership_id=a.membership_id
      WHERE a.workspace_id=$1 AND a.expires_at>now() AND COALESCE(pref.mode,'automatic')<>'invisible'
      AND ($2::uuid[] IS NULL OR a.membership_id=ANY($2::uuid[]))
      AND (m.access_type='member' AND EXISTS(SELECT 1 FROM memberships viewer WHERE viewer.workspace_id=$1 AND viewer.id=$3 AND viewer.access_type='member') OR a.membership_id=$3 OR EXISTS(SELECT 1 FROM conversation_members own JOIN conversation_members peer ON peer.workspace_id=own.workspace_id AND peer.conversation_id=own.conversation_id WHERE own.workspace_id=$1 AND own.membership_id=$3 AND peer.membership_id=a.membership_id AND external_channel_current(own.workspace_id,peer.membership_id,own.conversation_id)))
      GROUP BY a.membership_id,pref.mode ORDER BY a.membership_id LIMIT 1001`,
      [p.workspaceId, membershipIds ?? null, p.membershipId],
    );
    const typing = await this.db.query(
      `SELECT a.membership_id,m.name,a.typing_conversation_id conversation_id,a.typing_thread_id thread_id,
      LEAST(8000,GREATEST(0,max(extract(epoch FROM a.typing_expires_at-now())*1000)))::double precision expires_in_ms
      FROM activity_sessions a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id AND m.status='active' AND m.kind='human'
      JOIN sessions s ON s.workspace_id=a.workspace_id AND s.membership_id=a.membership_id AND s.token_hash=a.session_hash AND s.expires_at>now()
      JOIN conversations c ON c.workspace_id=a.workspace_id AND c.id=a.typing_conversation_id
      LEFT JOIN activity_preferences pref ON pref.workspace_id=a.workspace_id AND pref.membership_id=a.membership_id
      WHERE a.workspace_id=$1 AND a.expires_at>now() AND a.state='active' AND a.typing_expires_at>now() AND COALESCE(pref.mode,'automatic')='automatic'
      AND (c.visibility='public' OR (EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=$2) AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=a.membership_id)))
      GROUP BY a.membership_id,m.name,a.typing_conversation_id,a.typing_thread_id ORDER BY a.membership_id,a.typing_conversation_id,a.typing_thread_id LIMIT 100`,
      [p.workspaceId, p.membershipId],
    );
    return {
      own_mode: preference?.mode ?? 'automatic',
      presence: presence.slice(0, 1000),
      typing,
      presence_complete: presence.length <= 1000,
      sampled_at: new Date().toISOString(),
      presence_lease_ms: 60000,
    };
  }
}
