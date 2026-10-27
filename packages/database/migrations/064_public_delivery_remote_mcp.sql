ALTER TABLE tool_connections ADD COLUMN protocol text NOT NULL DEFAULT 'adapter' CHECK(protocol IN ('adapter','mcp'));
ALTER TABLE tool_connections ADD COLUMN conversation_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE tool_connections ADD COLUMN mcp_manifest jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tool_connections ADD COLUMN health text NOT NULL DEFAULT 'unchecked' CHECK(health IN ('unchecked','healthy','failed'));
ALTER TABLE tool_connections ADD COLUMN checked_at timestamptz;
CREATE TABLE developer_webhooks (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,owner_id uuid NOT NULL,name text NOT NULL,url text NOT NULL,
 encrypted_secret text NOT NULL,conversation_ids uuid[] NOT NULL,event_types text[] NOT NULL,
 auth_version integer NOT NULL,policy_version integer NOT NULL,version integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT true,cursor bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE developer_deliveries (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,webhook_id uuid NOT NULL,webhook_version integer NOT NULL,
 event_id bigint NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered','dead','cancelled')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,
 error_code text,delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,webhook_id,webhook_version,event_id),
 FOREIGN KEY(workspace_id,webhook_id) REFERENCES developer_webhooks(workspace_id,id)
);
CREATE INDEX developer_delivery_due ON developer_deliveries(workspace_id,available_at) WHERE state='pending';
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['developer_webhooks','developer_deliveries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END
$body$;
CREATE POLICY owner_webhook ON developer_webhooks AS RESTRICTIVE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY owner_delivery ON developer_deliveries AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM developer_webhooks w WHERE w.workspace_id=developer_deliveries.workspace_id AND w.id=webhook_id)) WITH CHECK(EXISTS(SELECT 1 FROM developer_webhooks w WHERE w.workspace_id=developer_deliveries.workspace_id AND w.id=webhook_id));
