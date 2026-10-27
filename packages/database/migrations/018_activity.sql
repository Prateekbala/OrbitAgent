ALTER TABLE sessions ADD CONSTRAINT session_activity_identity UNIQUE(workspace_id,membership_id,token_hash);
GRANT SELECT(token_hash,expires_at) ON sessions TO ao_runtime;
GRANT SELECT(workspace_id,membership_id,token_hash,expires_at) ON sessions TO ao_worker;
CREATE POLICY worker_sessions_read ON sessions FOR SELECT TO ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE TABLE activity_preferences (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 mode text NOT NULL DEFAULT 'automatic' CHECK(mode IN ('automatic','away','invisible')),
 PRIMARY KEY(workspace_id,membership_id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE activity_sessions (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 session_hash text NOT NULL,
 client_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('active','away')),
 revision bigint NOT NULL CHECK(revision>0),
 expires_at timestamptz NOT NULL,
 typing_revision bigint NOT NULL DEFAULT 0 CHECK(typing_revision>=0),
 typing_conversation_id uuid,
 typing_thread_id uuid,
 typing_expires_at timestamptz,
 PRIMARY KEY(workspace_id,membership_id,session_hash,client_id),
 FOREIGN KEY(workspace_id,membership_id,session_hash) REFERENCES sessions(workspace_id,membership_id,token_hash) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,typing_conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,typing_conversation_id,typing_thread_id) REFERENCES messages(workspace_id,conversation_id,id),
 CHECK((typing_conversation_id IS NOT NULL AND typing_expires_at IS NOT NULL) OR (typing_conversation_id IS NULL AND typing_thread_id IS NULL AND typing_expires_at IS NULL))
);
CREATE INDEX activity_expiry ON activity_sessions(workspace_id,expires_at);
ALTER TABLE activity_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE activity_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_sessions FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON activity_preferences,activity_sessions TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON activity_preferences TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON activity_sessions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
