import { randomUUID } from 'node:crypto';
import type { Database, Sql } from '@ao/database';
import type { z } from 'zod';
import type {
  CallSnapshot,
  CallTicket,
  callCreate,
  callJoin,
  callTranscriptInput,
  callNotes,
} from '@ao/contracts/calls';
import type { Identity } from '../lib/policy.js';
import { requireActiveMember, requireConversation } from '../lib/policy.js';
import { requirePerson } from '../notifications/service.js';
import { AppError, notFound } from '../lib/errors.js';
import type { CallMedia } from './provider.js';

export async function callAccess(tx: Sql, p: Identity, id: string, lock = false) {
  if (p.permissions?.['messages.read'] === false)
    throw new AppError(403, 'PERMISSION_DENIED', 'Call access requires message access.');
  const [call] = await tx.query(
    `SELECT * FROM calls WHERE workspace_id=$1 AND id=$2 AND expires_at>now()${lock ? ' FOR UPDATE' : ''}`,
    [p.workspaceId, id],
  );
  if (!call) throw notFound();
  await requireConversation(tx, p, String(call.conversation_id), lock);
  return call;
}
async function actor(tx: Sql, p: Identity) {
  requirePerson(p);
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
  await requireActiveMember(tx, p, p.membershipId);
}
async function changed(tx: Sql, p: Identity, call: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO outbox_events(workspace_id,event_type,resource_id,conversation_id) VALUES($1,'call.changed',$2,$3)",
    [p.workspaceId, call.id, call.conversation_id],
  );
}
export class CallService {
  constructor(
    private readonly db: Database,
    private readonly media?: CallMedia,
  ) {}
  capabilities() {
    return {
      calls: Boolean(this.media),
      recording: this.media?.recording ?? false,
      voiceAgents: false,
      transcription: 'participant_captions',
    };
  }
  async list(p: Identity, conversation: string, before?: string) {
    await requireConversation(this.db, p, conversation);
    return this.db.query(
      'SELECT id,mode,state,recording_state,owner_id,created_at,ended_at,expires_at FROM calls WHERE workspace_id=$1 AND conversation_id=$2 AND expires_at>now() AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM calls WHERE workspace_id=$1 AND id=$3 AND conversation_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 31',
      [p.workspaceId, conversation, before ?? null],
    );
  }
  async snapshot(p: Identity, id: string): Promise<CallSnapshot> {
    const call = await callAccess(this.db, p, id);
    const participants = await this.db.query(
      "SELECT cp.id,cp.membership_id,m.name,cp.consent,cp.voice_consent,cp.state FROM call_participants cp JOIN memberships m ON m.workspace_id=cp.workspace_id AND m.id=cp.membership_id WHERE cp.workspace_id=$1 AND cp.call_id=$2 AND cp.state='joined' AND cp.expires_at>now() ORDER BY cp.joined_at LIMIT 50",
      [p.workspaceId, id],
    );
    return {
      id: String(call.id),
      conversation_id: String(call.conversation_id),
      owner_id: String(call.owner_id),
      mode: call.mode,
      state: call.state,
      recording_state: call.recording_state,
      room_name: call.room_name,
      expires_at: call.expires_at,
      created_at: call.created_at,
      participants,
    } as unknown as CallSnapshot;
  }
  async create(p: Identity, conversation: string, input: z.infer<typeof callCreate>) {
    if (!this.media || (input.mode === 'retained_recording' && !this.media.recording))
      throw new AppError(
        503,
        'CALLS_UNAVAILABLE',
        'Configure the media and recording services first.',
      );
    const id = await this.db.transaction(async (tx) => {
      await actor(tx, p);
      await requireConversation(tx, p, conversation, true);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77219))', [
        p.workspaceId + ':' + conversation,
      ]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77220))', [p.workspaceId]);
      if (input.mode !== 'no_recording') {
        const [allowed] = await tx.query('SELECT call_recording_allowed($1,$2) allowed', [
          p.workspaceId,
          conversation,
        ]);
        if (!allowed?.allowed)
          throw new AppError(
            403,
            'SHARED_RECORDING_DISABLED',
            'Shared channels prohibit recording and transcription.',
          );
      }
      const [prior] = await tx.query(
        'SELECT id,mode,conversation_id,extract(epoch FROM expires_at-created_at)/86400 retention_days FROM calls WHERE workspace_id=$1 AND owner_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (prior) {
        if (
          prior.mode !== input.mode ||
          prior.conversation_id !== conversation ||
          Number(prior.retention_days) !== input.retentionDays
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This request has different recording settings.',
          );
        return String(prior.id);
      }
      const [existing] = await tx.query(
        "SELECT id FROM calls WHERE workspace_id=$1 AND conversation_id=$2 AND state IN ('active','ending')",
        [p.workspaceId, conversation],
      );
      if (existing)
        throw new AppError(409, 'CALL_ACTIVE', 'Join the existing call or wait for it to end.');
      const [capacity] = await tx.query('SELECT call_capacity_available($1,$2) available', [
        p.workspaceId,
        input.mode === 'retained_recording',
      ]);
      if (!capacity?.available)
        throw new AppError(
          429,
          'CALL_CAPACITY',
          'This workspace has reached its concurrent call capacity.',
        );
      const value = randomUUID();
      await tx.query(
        'INSERT INTO calls(id,workspace_id,conversation_id,owner_id,client_id,mode,room_name,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::interval)',
        [
          value,
          p.workspaceId,
          conversation,
          p.membershipId,
          input.clientId,
          input.mode,
          'orbit-' + value,
          input.retentionDays + ' days',
        ],
      );
      await changed(tx, p, { id: value, conversation_id: conversation });
      return value;
    });
    return this.snapshot(p, id);
  }
  async join(
    p: Identity,
    id: string,
    input: z.infer<typeof callJoin>,
    sessionHash: string,
  ): Promise<CallTicket> {
    if (!this.media)
      throw new AppError(503, 'CALLS_UNAVAILABLE', 'Media service is not configured.');
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.state !== 'active')
        throw new AppError(409, 'CALL_ENDED', 'This call is ending or ended.');
      const [session] = await tx.query(
        'SELECT token_hash FROM sessions WHERE workspace_id=$1 AND membership_id=$2 AND token_hash=$3 AND expires_at>now()',
        [p.workspaceId, p.membershipId, sessionHash],
      );
      if (!session)
        throw new AppError(
          403,
          'SESSION_REQUIRED',
          'An active account session is required to join calls.',
        );
      if (call.mode !== 'no_recording' && !input.consent)
        throw new AppError(
          409,
          'CALL_CONSENT_REQUIRED',
          'Explicit consent is required for this call mode.',
        );
      const [removed] = await tx.query(
        "SELECT id FROM call_participants WHERE workspace_id=$1 AND call_id=$2 AND membership_id=$3 AND state='removed'",
        [p.workspaceId, id, p.membershipId],
      );
      if (removed) throw new AppError(403, 'CALL_REMOVED', 'You have been removed from this call.');
      const [count] = await tx.query(
        "SELECT count(*)::int total FROM call_participants WHERE workspace_id=$1 AND call_id=$2 AND state='joined' AND expires_at>now()",
        [p.workspaceId, id],
      );
      if (Number(count!.total) >= 50)
        throw new AppError(409, 'CALL_FULL', 'This call has reached its participant limit.');
      const [participant] = await tx.query(
        "INSERT INTO call_participants(id,workspace_id,call_id,membership_id,client_id,consent,voice_consent,auth_version,session_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,call_id,membership_id,client_id) DO UPDATE SET state='joined',consent=EXCLUDED.consent,voice_consent=EXCLUDED.voice_consent,auth_version=EXCLUDED.auth_version,session_hash=EXCLUDED.session_hash,meter_reference=CASE WHEN call_participants.state='joined' AND call_participants.expires_at>now() THEN call_participants.meter_reference ELSE gen_random_uuid() END,meter_started_at=CASE WHEN call_participants.state='joined' AND call_participants.expires_at>now() THEN call_participants.meter_started_at ELSE now() END,expires_at=now()+interval '60 seconds' RETURNING id,meter_reference",
        [
          randomUUID(),
          p.workspaceId,
          id,
          p.membershipId,
          input.clientId,
          input.consent,
          input.voiceAgentConsent,
          p.authVersion ?? 0,
          sessionHash,
        ],
      );
      await tx.query("SELECT commercial_reserve($1,'media',$2,14400,0)", [
        p.workspaceId,
        participant!.meter_reference,
      ]);
      await tx.query(
        "INSERT INTO call_consents(workspace_id,call_id,membership_id,recording,voice_agent,action) VALUES($1,$2,$3,$4,$5,'join')",
        [p.workspaceId, id, p.membershipId, input.consent, input.voiceAgentConsent],
      );
      await this.media!.ensureRoom(String(call.room_name));
      const token = await this.media!.ticket(
        String(call.room_name),
        String(participant!.id),
        p.name,
      );
      await changed(tx, p, call);
      const participants = await tx.query(
        "SELECT cp.id,cp.membership_id,m.name,cp.consent,cp.voice_consent,cp.state FROM call_participants cp JOIN memberships m ON m.workspace_id=cp.workspace_id AND m.id=cp.membership_id WHERE cp.workspace_id=$1 AND cp.call_id=$2 AND cp.state='joined' AND cp.expires_at>now()",
        [p.workspaceId, id],
      );
      const { egress_id: _egress, recording_key: _key, notes: _notes, ...safe } = call;
      return {
        call: { ...safe, participants } as unknown as CallSnapshot,
        participantId: String(participant!.id),
        token,
        url: this.media!.url,
      };
    });
  }
  async heartbeat(p: Identity, id: string, participant: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.state !== 'active') throw new AppError(409, 'CALL_ENDED', 'The call has ended.');
      const rows = await tx.query(
        "UPDATE call_participants SET expires_at=now()+interval '60 seconds' WHERE workspace_id=$1 AND call_id=$2 AND id=$3 AND membership_id=$4 AND state='joined' AND expires_at>now() RETURNING id",
        [p.workspaceId, id, participant, p.membershipId],
      );
      if (!rows.length) throw notFound();
      return { ok: true };
    });
  }
  async leave(p: Identity, id: string, participant: string, withdraw = false) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      const rows = await tx.query(
        "UPDATE call_participants SET state='left',expires_at=now(),consent=CASE WHEN $5 THEN false ELSE consent END WHERE workspace_id=$1 AND call_id=$2 AND id=$3 AND membership_id=$4 RETURNING id",
        [p.workspaceId, id, participant, p.membershipId, withdraw],
      );
      if (!rows.length) throw notFound();
      await tx.query(
        'INSERT INTO call_consents(workspace_id,call_id,membership_id,recording,voice_agent,action) VALUES($1,$2,$3,false,false,$4)',
        [p.workspaceId, id, p.membershipId, withdraw ? 'withdraw' : 'leave'],
      );
      if (withdraw && call.mode !== 'no_recording')
        await tx.query(
          "UPDATE calls SET state='ending',recording_state=CASE WHEN mode='retained_recording' THEN 'stopping' ELSE recording_state END WHERE workspace_id=$1 AND id=$2",
          [p.workspaceId, id],
        );
      await changed(tx, p, call);
      return { ok: true };
    });
  }
  async end(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.owner_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
        throw new AppError(
          403,
          'CALL_OWNER_REQUIRED',
          'Only the call host or an administrator can end this call.',
        );
      await tx.query(
        "UPDATE calls SET state='ending',recording_state=CASE WHEN mode='retained_recording' THEN 'stopping' ELSE recording_state END WHERE workspace_id=$1 AND id=$2 AND state='active'",
        [p.workspaceId, id],
      );
      await changed(tx, p, call);
      return { ok: true };
    });
  }
  async remove(p: Identity, id: string, participant: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.owner_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
        throw new AppError(
          403,
          'CALL_OWNER_REQUIRED',
          'Only the host or an administrator can remove participants.',
        );
      const [row] = await tx.query(
        "UPDATE call_participants SET state='removed',expires_at=now() WHERE workspace_id=$1 AND call_id=$2 AND id=$3 RETURNING membership_id",
        [p.workspaceId, id, participant],
      );
      if (!row) throw notFound();
      await tx.query(
        "INSERT INTO call_consents(workspace_id,call_id,membership_id,recording,voice_agent,action) VALUES($1,$2,$3,false,false,'remove')",
        [p.workspaceId, id, row.membership_id],
      );
      await changed(tx, p, call);
      return { ok: true };
    });
  }
  async mute(p: Identity, id: string, participant: string) {
    if (!this.media)
      throw new AppError(503, 'CALLS_UNAVAILABLE', 'Media service is not configured.');
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.owner_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
        throw new AppError(
          403,
          'CALL_OWNER_REQUIRED',
          'Only the host or an administrator can mute participants.',
        );
      const [row] = await tx.query(
        "SELECT id FROM call_participants WHERE workspace_id=$1 AND call_id=$2 AND id=$3 AND state='joined' AND expires_at>now()",
        [p.workspaceId, id, participant],
      );
      if (!row) throw notFound();
      await this.media!.mute(String(call.room_name), participant);
      return { ok: true };
    });
  }
  async deleteContent(p: Identity, id: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.owner_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
        throw new AppError(
          403,
          'CALL_OWNER_REQUIRED',
          'Only the host or an administrator can delete call content.',
        );
      await tx.query('SELECT expire_call_content($1,$2)', [p.workspaceId, id]);
      await changed(tx, p, call);
      return { ok: true, purge_state: 'pending' };
    });
  }
  async segments(p: Identity, id: string, after = 0, afterId?: string, limit = 201) {
    await callAccess(this.db, p, id);
    return this.db.query(
      'SELECT s.id,s.speaker_id,m.name speaker_name,s.text,s.start_ms,s.end_ms,s.version,s.source FROM call_segments s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.id=s.speaker_id WHERE s.workspace_id=$1 AND s.call_id=$2 AND s.start_ms>=$3 AND ($4::uuid IS NULL OR (s.start_ms,s.id)>(SELECT start_ms,id FROM call_segments WHERE workspace_id=$1 AND call_id=$2 AND id=$4)) ORDER BY s.start_ms,s.id LIMIT $5',
      [p.workspaceId, id, after, afterId ?? null, limit],
    );
  }
  async append(p: Identity, id: string, input: z.infer<typeof callTranscriptInput>) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      if (call.mode !== 'retained_recording' || call.state !== 'active')
        throw new AppError(
          409,
          'TRANSCRIPT_NOT_RETAINED',
          'This call does not retain transcripts.',
        );
      const [participant] = await tx.query(
        "SELECT id FROM call_participants WHERE workspace_id=$1 AND call_id=$2 AND membership_id=$3 AND state='joined' AND consent AND expires_at>now()",
        [p.workspaceId, id, p.membershipId],
      );
      if (!participant)
        throw new AppError(
          403,
          'CALL_PARTICIPANT_REQUIRED',
          'Join and consent before submitting your captions.',
        );
      const [prior] = await tx.query(
        'SELECT id,text,start_ms,end_ms FROM call_segments WHERE workspace_id=$1 AND call_id=$2 AND speaker_id=$3 AND client_id=$4',
        [p.workspaceId, id, p.membershipId, input.clientId],
      );
      if (prior) {
        if (
          prior.text !== input.text ||
          prior.start_ms !== input.startMs ||
          prior.end_ms !== input.endMs
        )
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Caption request changed.');
        return { id: prior.id };
      }
      const segment = randomUUID();
      const [size] = await tx.query(
        'SELECT count(*)::int total,coalesce(sum(length(s.text)+length(m.name)+3),0)::int characters FROM call_segments s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.id=s.speaker_id WHERE s.workspace_id=$1 AND s.call_id=$2',
        [p.workspaceId, id],
      );
      if (
        Number(size!.total) >= 2000 ||
        Number(size!.characters) + input.text.length + p.name.length + 3 > 200000
      )
        throw new AppError(
          409,
          'TRANSCRIPT_LIMIT',
          'This call has reached its retained transcript limit.',
        );
      await tx.query(
        'INSERT INTO call_segments(id,workspace_id,call_id,speaker_id,client_id,text,start_ms,end_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          segment,
          p.workspaceId,
          id,
          p.membershipId,
          input.clientId,
          input.text,
          input.startMs,
          input.endMs,
        ],
      );
      await tx.query(
        'INSERT INTO call_segment_versions(workspace_id,segment_id,version,text,editor_id) VALUES($1,$2,1,$3,$4)',
        [p.workspaceId, segment, input.text, p.membershipId],
      );
      await changed(tx, p, call);
      return { id: segment };
    });
  }
  async correct(p: Identity, id: string, segment: string, version: number, text: string) {
    return this.db.transaction(async (tx) => {
      await actor(tx, p);
      const call = await callAccess(tx, p, id, true);
      const [row] = await tx.query(
        'SELECT speaker_id,version FROM call_segments WHERE workspace_id=$1 AND call_id=$2 AND id=$3 FOR UPDATE',
        [p.workspaceId, id, segment],
      );
      if (!row) throw notFound();
      if (
        row.speaker_id !== p.membershipId &&
        call.owner_id !== p.membershipId &&
        !['owner', 'admin'].includes(p.role)
      )
        throw new AppError(
          403,
          'TRANSCRIPT_EDITOR_REQUIRED',
          'Correct your own speech or ask the host.',
        );
      if (row.version !== version)
        throw new AppError(
          409,
          'VERSION_CONFLICT',
          'Refresh this transcript before correcting it.',
        );
      await tx.query(
        'UPDATE call_segments SET text=$4,version=version+1 WHERE workspace_id=$1 AND call_id=$2 AND id=$3',
        [p.workspaceId, id, segment, text],
      );
      await tx.query(
        'INSERT INTO call_segment_versions(workspace_id,segment_id,version,text,editor_id) VALUES($1,$2,$3,$4,$5)',
        [p.workspaceId, segment, version + 1, text, p.membershipId],
      );
      await tx.query(
        'UPDATE calls SET notes=NULL,notes_version=notes_version+1 WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, id],
      );
      await changed(tx, p, call);
      return { ok: true };
    });
  }
  async notes(p: Identity, id: string, input?: z.infer<typeof callNotes>) {
    return this.db.transaction(async (tx) => {
      if (input) await actor(tx, p);
      const call = await callAccess(tx, p, id, Boolean(input));
      if (input) {
        if (call.owner_id !== p.membershipId && !['owner', 'admin'].includes(p.role))
          throw new AppError(403, 'CALL_OWNER_REQUIRED', 'Only the host can publish call notes.');
        if (call.mode !== 'retained_recording')
          throw new AppError(
            409,
            'NOTES_NOT_RETAINED',
            'This call does not retain meeting content.',
          );
        if (Number(call.notes_version) !== input.version)
          throw new AppError(409, 'VERSION_CONFLICT', 'Refresh call notes before editing.');
        for (const action of input.proposedActions) {
          if (action.assigneeId) await requireActiveMember(tx, p, action.assigneeId);
          const [count] = await tx.query(
            'SELECT count(*)::int total FROM call_segments WHERE workspace_id=$1 AND call_id=$2 AND id=ANY($3::uuid[])',
            [p.workspaceId, id, action.sourceSegmentIds],
          );
          if (Number(count!.total) !== new Set(action.sourceSegmentIds).size)
            throw new AppError(
              400,
              'INVALID_PROVENANCE',
              'Every proposed action must cite this call.',
            );
        }
        await tx.query(
          'UPDATE calls SET notes=$3::jsonb,notes_version=notes_version+1 WHERE workspace_id=$1 AND id=$2',
          [p.workspaceId, id, JSON.stringify(input)],
        );
        await changed(tx, p, call);
      }
      return input
        ? { version: Number(call.notes_version) + 1, notes: input }
        : { version: Number(call.notes_version), notes: call.notes };
    });
  }
}
