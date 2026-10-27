import { dispatcherScope, scopedDatabase, workerScope, type Database } from '@ao/database';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallMedia } from './provider.js';

export class CallWorker {
  private readonly db: Database;
  private pending: Promise<void> | undefined;
  constructor(
    db: Database,
    private readonly media?: CallMedia,
    private readonly directory?: string,
    private readonly onError: (code: string) => void = () => {},
  ) {
    this.db = scopedDatabase(db);
  }
  tick() {
    if (this.pending) return this.pending;
    this.pending = this.process().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start() {
    const timer = setInterval(
      () => void this.tick().catch(() => this.onError('CALL_WORKER_FAILED')),
      3000,
    );
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.pending;
    };
  }
  private async process() {
    for (const workspace of await dispatcherScope(() =>
      this.db.query('SELECT id FROM workspaces'),
    )) {
      await workerScope(String(workspace.id), async () => {
        const calls = await this.db.query(
          "SELECT id FROM calls WHERE workspace_id=$1 AND (state<>'ended' OR recording_state IN ('stopping','uncertain') OR expires_at<=now() AND recording_deleted_at IS NULL) ORDER BY created_at LIMIT 100",
          [workspace.id],
        );
        for (const { id } of calls)
          await this.db.transaction(async (tx) => {
            const [call] = await tx.query(
              'SELECT * FROM calls WHERE workspace_id=$1 AND id=$2 FOR UPDATE SKIP LOCKED',
              [workspace.id, id],
            );
            if (!call) return;
            const room = String(call.room_name);
            if (
              call.state === 'ended' &&
              ['stopping', 'uncertain'].includes(String(call.recording_state)) &&
              this.media
            ) {
              const recordings = await this.media.recordings(room);
              for (const recording of recordings.filter((r) => r.state === 'active'))
                await this.media.stopRecording(recording.id);
              await this.media.close(room);
              const settled =
                recordings.length > 0 && recordings.every((r) => r.state !== 'active');
              const confirmedAbsent =
                recordings.length === 0 &&
                call.ended_at !== null &&
                Date.now() - new Date(String(call.ended_at)).getTime() > 60000;
              if (settled || confirmedAbsent)
                await tx.query(
                  "UPDATE calls SET recording_state='stopped' WHERE workspace_id=$1 AND id=$2",
                  [workspace.id, id],
                );
            }
            const participants = await tx.query(
              `SELECT cp.*,m.status,a.auth_version current_auth, (coalesce((m.permissions->>'messages.read')::boolean,true) AND EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=cp.workspace_id AND s.membership_id=cp.membership_id AND s.token_hash=cp.session_hash AND s.expires_at>now()) AND retrieval_principal_current(cp.workspace_id,cp.membership_id) AND resource_visible_to(cp.workspace_id,c.conversation_id,c.created_at,cp.membership_id)) allowed FROM call_participants cp JOIN calls c ON c.workspace_id=cp.workspace_id AND c.id=cp.call_id JOIN memberships m ON m.workspace_id=cp.workspace_id AND m.id=cp.membership_id LEFT JOIN member_account_authority($1,cp.membership_id) a ON true WHERE cp.workspace_id=$1 AND cp.call_id=$2`,
              [workspace.id, id],
            );
            for (const member of participants) {
              const invalid =
                member.state !== 'joined' ||
                new Date(String(member.expires_at)).getTime() <= Date.now() ||
                member.status !== 'active' ||
                !member.allowed ||
                Number(member.auth_version) !== Number(member.current_auth);
              if (invalid && this.media) {
                await this.media.remove(room, String(member.id));
                await tx.query(
                  "UPDATE call_participants SET state=CASE WHEN state='removed' THEN state ELSE 'left' END WHERE workspace_id=$1 AND id=$2",
                  [workspace.id, member.id],
                );
              }
            }
            const active = participants.filter(
              (p) =>
                p.state === 'joined' &&
                p.status === 'active' &&
                p.allowed &&
                Number(p.auth_version) === Number(p.current_auth) &&
                new Date(String(p.expires_at)).getTime() > Date.now(),
            );
            const ending =
              call.state === 'ending' ||
              new Date(String(call.expires_at)).getTime() <= Date.now() ||
              Date.now() - new Date(String(call.created_at)).getTime() > 4 * 3600000 ||
              (!active.length && Date.now() - new Date(String(call.created_at)).getTime() > 120000);
            if (ending && call.state !== 'ended' && this.media) {
              const recordings =
                call.mode === 'retained_recording' ? await this.media.recordings(room) : [];
              for (const recording of recordings.filter((r) => r.state === 'active'))
                await this.media.stopRecording(recording.id);
              await this.media.close(room);
              await tx.query(
                "UPDATE calls SET state='ended',ended_at=coalesce(ended_at,now()),recording_state=CASE WHEN mode<>'retained_recording' THEN 'off' WHEN $3 THEN 'stopping' WHEN recording_state='uncertain' AND egress_id IS NULL THEN 'uncertain' ELSE 'stopped' END WHERE workspace_id=$1 AND id=$2",
                [workspace.id, id, recordings.some((r) => r.state === 'active')],
              );
              await tx.query(
                "UPDATE call_participants SET state=CASE WHEN state='removed' THEN state ELSE 'left' END,expires_at=now() WHERE workspace_id=$1 AND call_id=$2",
                [workspace.id, id],
              );
            } else if (
              call.state === 'active' &&
              call.mode === 'retained_recording' &&
              this.media &&
              active.length
            ) {
              const existing = await this.media.recordings(room);
              const recording = existing.find((r) => r.state === 'active');
              if (recording)
                await tx.query(
                  "UPDATE calls SET egress_id=$3,recording_state='recording' WHERE workspace_id=$1 AND id=$2",
                  [workspace.id, id, recording.id],
                );
              else if (call.recording_state === 'off')
                await tx.query(
                  "UPDATE calls SET recording_state='starting',recording_key=$3 WHERE workspace_id=$1 AND id=$2",
                  [workspace.id, id, String(id) + '.mp4'],
                );
            }
            const [hold] = await tx.query('SELECT governance_held($1,$2) held', [
              workspace.id,
              call.conversation_id,
            ]);
            if (!hold?.held && new Date(String(call.expires_at)).getTime() <= Date.now()) {
              const mediaSettled =
                call.mode !== 'retained_recording' ||
                call.recording_state === 'off' ||
                call.recording_state === 'stopped';
              if (
                mediaSettled &&
                call.recording_key &&
                this.directory &&
                /^[0-9a-f-]{36}\.mp4$/.test(String(call.recording_key))
              )
                await rm(join(this.directory, String(call.recording_key)), { force: true });
              if (
                mediaSettled &&
                this.directory &&
                typeof call.egress_id === 'string' &&
                /^EG_[A-Za-z0-9_-]{1,100}$/.test(call.egress_id)
              )
                await rm(join(this.directory, call.egress_id + '.json'), { force: true });
              await tx.query('DELETE FROM call_segments WHERE workspace_id=$1 AND call_id=$2', [
                workspace.id,
                id,
              ]);
              if (mediaSettled)
                await tx.query(
                  'UPDATE calls SET recording_deleted_at=now(),notes=NULL WHERE workspace_id=$1 AND id=$2',
                  [workspace.id, id],
                );
            }
          });
        if (this.media) {
          const starts = await this.db.query(
            "UPDATE calls SET recording_state='uncertain' WHERE workspace_id=$1 AND state='active' AND recording_state='starting' RETURNING id,room_name,recording_key",
            [workspace.id],
          );
          for (const call of starts) {
            try {
              await this.db.transaction(async (tx) => {
                const [current] = await tx.query(
                  "SELECT id FROM calls WHERE workspace_id=$1 AND id=$2 AND state='active' AND recording_state='uncertain' FOR UPDATE",
                  [workspace.id, call.id],
                );
                if (!current) return;
                const egress = await this.media!.record(
                  String(call.room_name),
                  String(call.recording_key),
                );
                await tx.query(
                  "UPDATE calls SET egress_id=$3,recording_state='recording' WHERE workspace_id=$1 AND id=$2 AND state='active' AND recording_state='uncertain'",
                  [workspace.id, call.id, egress],
                );
              });
            } catch {
              this.onError('CALL_RECORDING_OUTCOME_UNKNOWN');
            }
          }
        }
      });
    }
  }
}
