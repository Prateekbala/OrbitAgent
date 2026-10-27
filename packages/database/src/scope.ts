import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database, Sql } from './index.js';
type Role =
  'ao_runtime' | 'ao_identity' | 'ao_dispatcher' | 'ao_worker' | 'ao_erasure' | 'ao_model_broker';
interface Scope {
  role: Role;
  workspaceId: string | null;
  membershipId?: string;
  accessType?: string;
  accountSessionId?: string;
  agentCredentialId?: string;
  platformCredentialId?: string;
}
const storage = new AsyncLocalStorage<Scope>();
const wrapped = new WeakMap<Database, Database>();
export function requestScope(done: () => void) {
  storage.run({ role: 'ao_runtime', workspaceId: null }, done);
}
export function identifyWorkspace(workspaceId: string) {
  const scope = storage.getStore();
  if (!scope) throw new Error('Workspace resolution requires an isolated request scope.');
  scope.workspaceId = workspaceId;
}
export function identifyPrincipal(membershipId: string, accessType: string) {
  const scope = storage.getStore();
  if (!scope) throw new Error('Principal resolution requires an isolated request scope.');
  scope.membershipId = membershipId;
  scope.accessType = accessType;
}
export function identifyAccountSession(sessionId: string) {
  const scope = storage.getStore();
  if (!scope) throw new Error('Account resolution requires an isolated request scope.');
  scope.accountSessionId = sessionId;
}
export function identifyAgentCredential(id: string) {
  const scope = storage.getStore();
  if (!scope) throw new Error('Credential resolution requires an isolated request scope.');
  scope.agentCredentialId = id;
}
export function identifyPlatformCredential(id: string) {
  const scope = storage.getStore();
  if (!scope) throw new Error('Credential resolution requires an isolated request scope.');
  scope.platformCredentialId = id;
}
export function accountSessionId() {
  return storage.getStore()?.accountSessionId;
}
export function identityScope<T>(work: () => Promise<T>, workspaceId: string | null = null) {
  const sessionId = accountSessionId();
  return storage.run(
    { role: 'ao_identity', workspaceId, ...(sessionId ? { accountSessionId: sessionId } : {}) },
    work,
  );
}
export function workerScope<T>(workspaceId: string, work: () => Promise<T>) {
  return storage.run({ role: 'ao_worker', workspaceId }, work);
}
export function erasureScope<T>(work: () => Promise<T>) {
  return storage.run({ role: 'ao_erasure', workspaceId: null }, work);
}
export function modelBrokerScope<T>(workspaceId: string, work: () => Promise<T>) {
  return storage.run({ role: 'ao_model_broker', workspaceId }, work);
}
export function dispatcherScope<T>(work: () => Promise<T>) {
  return storage.run({ role: 'ao_dispatcher', workspaceId: null }, work);
}
export function tenantScope<T>(workspaceId: string, work: () => Promise<T>) {
  const prior = storage.getStore();
  return storage.run(
    { ...(prior?.workspaceId === workspaceId ? prior : {}), role: 'ao_runtime', workspaceId },
    work,
  );
}
export function scopedDatabase(base: Database): Database {
  const previous = wrapped.get(base);
  if (previous) return previous;
  async function bind(tx: Sql) {
    const scope = storage.getStore() ?? { role: 'ao_runtime' as const, workspaceId: null };
    await tx.query(`SET LOCAL ROLE ${scope.role}`);
    await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [scope.workspaceId ?? '']);
    await tx.query(
      "SELECT set_config('ao.membership_id',$1,true),set_config('ao.access_type',$2,true)",
      [scope.membershipId ?? '', scope.accessType ?? ''],
    );
    await tx.query("SELECT set_config('ao.platform_credential_id',$1,true)", [
      scope.platformCredentialId ?? '',
    ]);
    await tx.query("SELECT set_config('ao.agent_credential_id',$1,true)", [
      scope.agentCredentialId ?? '',
    ]);
  }
  const result: Database = {
    async query(sql, params = []) {
      return base.transaction(async (tx) => {
        await bind(tx);
        return tx.query(sql, params);
      });
    },
    async transaction(work) {
      return base.transaction(async (tx) => {
        await bind(tx);
        return work(tx);
      });
    },
    close: () => base.close(),
  };
  wrapped.set(base, result);
  wrapped.set(result, result);
  return result;
}
export async function assertRuntimeConnection(db: Database) {
  const [role] = await db.query(
    'SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user',
  );
  const [ownership] = await db.query(
    "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns",
  );
  if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit || ownership?.owns)
    throw new Error(
      'Production DATABASE_URL must use a non-owner login with NOINHERIT, without SUPERUSER, BYPASSRLS, or membership in a table-owner role.',
    );
  for (const privileged of ['ao_erasure', 'ao_model_broker']) {
    const [row] = await db.query("SELECT pg_has_role(current_user,$1,'MEMBER') allowed", [
      privileged,
    ]);
    if (row?.allowed)
      throw new Error('Application logins must not possess isolated service roles.');
  }
  for (const name of ['ao_runtime', 'ao_identity', 'ao_dispatcher', 'ao_worker']) {
    const [grant] = await db.query(
      "SELECT pg_has_role(current_user,$1,'MEMBER') AS allowed,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1",
      [name],
    );
    if (!grant?.allowed) throw new Error(`Runtime login requires membership in ${name}.`);
    if (grant.rolsuper || grant.rolbypassrls || grant.rolcanlogin)
      throw new Error(`Application role ${name} must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS.`);
  }
}
export async function assertIsolatedServiceConnection(
  db: Database,
  expected: 'ao_erasure' | 'ao_model_broker',
) {
  const [role] = await db.query(
    'SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user',
  );
  const [owns] = await db.query(
    "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER')) owns",
  );
  if (!role || role.rolsuper || role.rolbypassrls || role.rolinherit || owns?.owns)
    throw new Error('Use a dedicated non-owner NOINHERIT service login.');
  for (const name of [
    'ao_runtime',
    'ao_identity',
    'ao_worker',
    'ao_dispatcher',
    'ao_erasure',
    'ao_model_broker',
  ]) {
    const [row] = await db.query("SELECT pg_has_role(current_user,$1,'MEMBER') allowed", [name]);
    if (Boolean(row?.allowed) !== (name === expected))
      throw new Error('Dedicated service role grants are invalid.');
  }
}
