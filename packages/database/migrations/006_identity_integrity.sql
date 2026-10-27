ALTER TABLE sessions ADD COLUMN workspace_id uuid;
UPDATE sessions s SET workspace_id=m.workspace_id FROM memberships m WHERE m.id=s.membership_id;
ALTER TABLE sessions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_membership_fk FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id);


ALTER TABLE memberships ADD CONSTRAINT membership_account_tenant_unique UNIQUE(workspace_id,id,account_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_account_membership_fk FOREIGN KEY(workspace_id,membership_id,account_id) REFERENCES memberships(workspace_id,id,account_id);

CREATE POLICY workspace_identity_update ON workspaces FOR UPDATE TO ao_identity USING(id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_sessions ON sessions TO ao_identity USING(true) WITH CHECK(true);
GRANT DELETE ON sessions TO ao_runtime;
GRANT SELECT(workspace_id,membership_id) ON sessions TO ao_runtime;
CREATE POLICY tenant_sessions ON sessions TO ao_runtime USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
