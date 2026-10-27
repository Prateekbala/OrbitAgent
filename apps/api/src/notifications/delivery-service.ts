import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Database } from '@ao/database';
import {
  deliveryPreferences,
  type deviceRegistration,
  type scopedDeliveryPreference,
} from '@ao/contracts/delivery';
import type { Identity } from '../lib/policy.js';
import { requireActiveMember, requireConversation } from '../lib/policy.js';
import { IdentitySecrets } from '../identity/secrets.js';
import { requirePerson } from './service.js';
import { digest } from '../lib/security.js';
import { AppError, notFound } from '../lib/errors.js';
import { validatePushEndpoint, type PushProvider } from './delivery-providers.js';
export class NotificationDeliveryService {
  constructor(
    private readonly db: Database,
    private readonly secrets: IdentitySecrets,
    private readonly push?: PushProvider,
  ) {}
  async settings(p: Identity) {
    requirePerson(p);
    const [row] = await this.db.query(
      'SELECT preferences FROM notification_delivery_preferences WHERE workspace_id=$1 AND membership_id=$2',
      [p.workspaceId, p.membershipId],
    );
    return {
      preferences: deliveryPreferences.parse(row?.preferences ?? {}),
      publicKey: this.push?.publicKey ?? null,
      platforms: (['browser', 'desktop', 'ios', 'android'] as const).filter((platform) =>
        this.push?.supports(platform),
      ),
    };
  }
  async update(p: Identity, input: z.infer<typeof deliveryPreferences>) {
    requirePerson(p);
    await requireActiveMember(this.db, p, p.membershipId);
    await this.db.query(
      'INSERT INTO notification_delivery_preferences(workspace_id,membership_id,preferences) VALUES($1,$2,$3::jsonb) ON CONFLICT(workspace_id,membership_id) DO UPDATE SET preferences=EXCLUDED.preferences,updated_at=now()',
      [p.workspaceId, p.membershipId, JSON.stringify(input)],
    );
    return { ok: true };
  }
  async devices(p: Identity) {
    requirePerson(p);
    return this.db.query(
      'SELECT id,name,platform,last_seen_at,expires_at,revoked_at FROM notification_devices WHERE workspace_id=$1 AND membership_id=$2 ORDER BY last_seen_at DESC LIMIT 50',
      [p.workspaceId, p.membershipId],
    );
  }
  async register(p: Identity, session: string, input: z.infer<typeof deviceRegistration>) {
    requirePerson(p);
    if (!this.push?.supports(input.platform))
      throw new AppError(503, 'PUSH_UNAVAILABLE', 'This push platform is not configured.');
    if (input.subscription) {
      try {
        validatePushEndpoint(input.subscription.endpoint);
      } catch {
        throw new AppError(
          400,
          'PUSH_ENDPOINT_NOT_ALLOWED',
          'Use a supported push provider endpoint.',
        );
      }
    }
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [p.workspaceId]);
      await requireActiveMember(tx, p, p.membershipId);
      const [active] = await tx.query(
        'SELECT token_hash FROM sessions WHERE workspace_id=$1 AND membership_id=$2 AND token_hash=$3 AND expires_at>now()',
        [p.workspaceId, p.membershipId, session],
      );
      if (!active)
        throw new AppError(
          403,
          'SESSION_REQUIRED',
          'Register a device with an active browser session.',
        );
      const [count] = await tx.query(
        'SELECT count(*)::int total FROM notification_devices WHERE workspace_id=$1 AND membership_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [p.workspaceId, p.membershipId],
      );
      const [prior] = await tx.query(
        'SELECT id FROM notification_devices WHERE workspace_id=$1 AND membership_id=$2 AND client_id=$3',
        [p.workspaceId, p.membershipId, input.clientId],
      );
      if (Number(count!.total) >= 20 && !prior)
        throw new AppError(409, 'DEVICE_LIMIT', 'Revoke an old device before adding another.');
      const id = String(prior?.id ?? randomUUID());
      const ciphertext = this.secrets.seal(
        `notification-device:${p.workspaceId}:${id}`,
        JSON.stringify(input),
      );
      await tx.query(
        "INSERT INTO notification_devices(id,workspace_id,membership_id,client_id,name,platform,ciphertext,endpoint_hash,auth_version,session_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,membership_id,client_id) DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,ciphertext=EXCLUDED.ciphertext,endpoint_hash=EXCLUDED.endpoint_hash,auth_version=EXCLUDED.auth_version,session_hash=EXCLUDED.session_hash,last_seen_at=now(),expires_at=now()+interval '30 days',revoked_at=NULL",
        [
          id,
          p.workspaceId,
          p.membershipId,
          input.clientId,
          input.name,
          input.platform,
          ciphertext,
          digest(input.subscription?.endpoint ?? input.token!),
          p.authVersion ?? 0,
          session,
        ],
      );
      return { id };
    });
  }
  async revoke(p: Identity, id: string) {
    requirePerson(p);
    const rows = await this.db.query(
      'UPDATE notification_devices SET revoked_at=now(),ciphertext=NULL WHERE workspace_id=$1 AND membership_id=$2 AND id=$3 RETURNING id',
      [p.workspaceId, p.membershipId, id],
    );
    if (!rows.length) throw notFound();
    return { ok: true };
  }
  async scope(p: Identity, input: z.infer<typeof scopedDeliveryPreference>) {
    requirePerson(p);
    if (input.scope === 'conversation') await requireConversation(this.db, p, input.resourceId);
    else {
      const [row] = await this.db.query(
        input.scope === 'thread'
          ? 'SELECT conversation_id FROM messages WHERE workspace_id=$1 AND id=$2 AND thread_id IS NULL AND deleted_at IS NULL'
          : 'SELECT NULL::uuid conversation_id FROM agents WHERE workspace_id=$1 AND id=$2',
        [p.workspaceId, input.resourceId],
      );
      if (!row) throw notFound();
      if (row.conversation_id) await requireConversation(this.db, p, String(row.conversation_id));
    }
    await this.db.query(
      'INSERT INTO notification_scope_preferences(workspace_id,membership_id,scope,resource_id,mode) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,membership_id,scope,resource_id) DO UPDATE SET mode=EXCLUDED.mode',
      [p.workspaceId, p.membershipId, input.scope, input.resourceId, input.mode],
    );
    return { ok: true };
  }
  async history(p: Identity, before?: string) {
    requirePerson(p);
    return this.db.query(
      'SELECT id,notification_id,channel,device_id,generation,state,attempts,error_code,created_at,sent_at,received_at,opened_at FROM notification_deliveries WHERE workspace_id=$1 AND membership_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM notification_deliveries WHERE workspace_id=$1 AND membership_id=$2 AND id=$3)) ORDER BY created_at DESC,id DESC LIMIT 51',
      [p.workspaceId, p.membershipId, before ?? null],
    );
  }
}
