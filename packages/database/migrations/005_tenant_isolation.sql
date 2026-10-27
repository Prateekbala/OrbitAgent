DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_runtime') THEN CREATE ROLE ao_runtime NOLOGIN NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_identity') THEN CREATE ROLE ao_identity NOLOGIN NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_dispatcher') THEN CREATE ROLE ao_dispatcher NOLOGIN NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_worker') THEN CREATE ROLE ao_worker NOLOGIN NOBYPASSRLS; END IF;
END
$roles$;
GRANT ao_runtime,ao_identity,ao_dispatcher,ao_worker TO CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ao_runtime,ao_identity,ao_dispatcher,ao_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON accounts,sessions TO ao_identity;
GRANT SELECT,INSERT,UPDATE ON workspaces TO ao_identity;
GRANT SELECT(id) ON workspaces TO ao_dispatcher;
GRANT SELECT,UPDATE ON workspaces TO ao_runtime,ao_worker;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_tenant ON workspaces TO ao_runtime,ao_worker USING(id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY workspace_identity_read ON workspaces FOR SELECT TO ao_identity USING(true);
CREATE POLICY workspace_identity_insert ON workspaces FOR INSERT TO ao_identity WITH CHECK(id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY workspace_dispatch ON workspaces FOR SELECT TO ao_dispatcher USING(true);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON memberships TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON memberships TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON conversations TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON conversations TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON conversation_members TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON conversation_members TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON messages TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON messages TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON tasks TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON tasks TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE task_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_transitions FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON task_transitions TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON task_transitions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON agents TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON agents TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE agent_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_inbox FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON agent_inbox TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON agent_inbox TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE knowledge_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_pages FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_pages TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON knowledge_pages TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_versions TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON knowledge_versions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON outbox_events TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON outbox_events TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON audit_events TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON audit_events TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON agent_runs TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON agent_runs TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON tool_invocations TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON tool_invocations TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON approval_decisions TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON approval_decisions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON invitations TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON invitations TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE ON memberships,invitations TO ao_identity;
GRANT SELECT ON agents TO ao_identity;
GRANT INSERT ON conversations TO ao_identity;
CREATE POLICY identity_memberships_read ON memberships FOR SELECT TO ao_identity USING(true);
CREATE POLICY identity_memberships_insert ON memberships FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY identity_memberships_update ON memberships FOR UPDATE TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY identity_agents_read ON agents FOR SELECT TO ao_identity USING(true);
CREATE POLICY identity_invitations_read ON invitations FOR SELECT TO ao_identity USING(true);
CREATE POLICY identity_invitations_insert ON invitations FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY identity_invitations_update ON invitations FOR UPDATE TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY identity_seed_channels ON conversations FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT USAGE,SELECT ON SEQUENCE outbox_events_id_seq TO ao_runtime,ao_worker;

GRANT INSERT ON audit_events,outbox_events TO ao_identity;
CREATE POLICY identity_audit_insert ON audit_events FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY identity_outbox_insert ON outbox_events FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT USAGE,SELECT ON SEQUENCE outbox_events_id_seq TO ao_identity;
