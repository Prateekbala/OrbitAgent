CREATE TABLE developer_clients (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces, owner_id uuid NOT NULL,
 name text NOT NULL, redirect_uris text[] NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE platform_credentials (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces, owner_id uuid NOT NULL,
 name text NOT NULL, token_hash text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('api_key','oauth')),
 scopes text[] NOT NULL, conversation_ids uuid[] NOT NULL, workspace_resources boolean NOT NULL DEFAULT false,
 audiences text[] NOT NULL, resource text, client_id uuid REFERENCES developer_clients(id),
 family_id uuid, auth_version integer NOT NULL, policy_version integer NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz,
 rotated_from uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,rotated_from) REFERENCES platform_credentials(workspace_id,id),
 CHECK(cardinality(conversation_ids)>0 OR workspace_resources), CHECK(cardinality(scopes)>0)
);
CREATE TABLE developer_oauth_codes (
 hash text PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, client_id uuid NOT NULL REFERENCES developer_clients(id),
 redirect_uri text NOT NULL, challenge text NOT NULL, resource text NOT NULL, grants jsonb NOT NULL,
 auth_version integer NOT NULL, policy_version integer NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE developer_refresh_tokens (
 hash text PRIMARY KEY, workspace_id uuid NOT NULL, credential_id uuid NOT NULL, family_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,credential_id) REFERENCES platform_credentials(workspace_id,id)
);
CREATE INDEX platform_credential_owner ON platform_credentials(workspace_id,owner_id,created_at);
CREATE INDEX developer_refresh_family ON developer_refresh_tokens(family_id);
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['developer_clients','platform_credentials','developer_oauth_codes','developer_refresh_tokens'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO ao_runtime,ao_worker,ao_identity',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 EXECUTE format('CREATE POLICY credential_identity ON %I TO ao_identity USING(true) WITH CHECK(true)',name);
 END LOOP;
END
$body$;
CREATE POLICY own_credential ON platform_credentials AS RESTRICTIVE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY own_client ON developer_clients AS RESTRICTIVE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY no_runtime ON developer_oauth_codes AS RESTRICTIVE TO ao_runtime USING(false) WITH CHECK(false);
CREATE POLICY no_runtime ON developer_refresh_tokens AS RESTRICTIVE TO ao_runtime USING(false) WITH CHECK(false);
CREATE FUNCTION platform_credential_allows(conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT nullif(current_setting('ao.platform_credential_id',true),'') IS NULL OR EXISTS(
 SELECT 1 FROM public.platform_credentials c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id
 JOIN public.accounts a ON a.id=m.account_id JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.organizations o ON o.id=w.organization_id
 JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=a.id
 LEFT JOIN public.developer_clients dc ON dc.id=c.client_id
 WHERE c.workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid AND c.id=nullif(current_setting('ao.platform_credential_id',true),'')::uuid
 AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.kind='human' AND m.access_type='member'
 AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND a.auth_version=c.auth_version AND o.version=c.policy_version AND om.status='active'
 AND (cardinality(o.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(o.allowed_domains))
 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND (c.client_id IS NULL OR dc.revoked_at IS NULL)
 AND ((conversation IS NULL AND c.workspace_resources) OR conversation=ANY(c.conversation_ids)))
$body$;
REVOKE ALL ON FUNCTION platform_credential_allows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_credential_allows(uuid) TO ao_runtime,ao_worker;
CREATE POLICY platform_audience ON conversations AS RESTRICTIVE TO ao_runtime USING(platform_credential_allows(id)) WITH CHECK(platform_credential_allows(id));
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['messages','tasks','knowledge_pages','files','projects','agent_runs','outbox_events','audit_events','automations'] LOOP
 EXECUTE format('CREATE POLICY platform_audience ON %I AS RESTRICTIVE TO ao_runtime USING(platform_credential_allows(conversation_id)) WITH CHECK(platform_credential_allows(conversation_id))',name);
 END LOOP;
END
$body$;
ALTER TABLE agent_runs ADD COLUMN platform_credential_id uuid;
ALTER TABLE agent_runs ADD FOREIGN KEY(workspace_id,platform_credential_id) REFERENCES platform_credentials(workspace_id,id);
ALTER TABLE workflow_runs ADD COLUMN platform_credential_id uuid;
ALTER TABLE workflow_runs ADD FOREIGN KEY(workspace_id,platform_credential_id) REFERENCES platform_credentials(workspace_id,id);
CREATE FUNCTION platform_execution_allowed(tenant uuid,credential uuid,member uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.platform_credentials c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id JOIN public.accounts a ON a.id=m.account_id JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.organizations o ON o.id=w.organization_id JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=a.id LEFT JOIN public.developer_clients dc ON dc.id=c.client_id
 WHERE tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND c.workspace_id=tenant AND c.id=credential AND m.id=member AND m.status='active' AND m.kind='human' AND m.access_type='member' AND coalesce((m.permissions->>'execution.manage')::boolean,true) AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND a.auth_version=c.auth_version AND o.version=c.policy_version AND om.status='active' AND (cardinality(o.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(o.allowed_domains)) AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND (c.client_id IS NULL OR dc.revoked_at IS NULL) AND 'execution.manage'=ANY(c.scopes) AND conversation=ANY(c.conversation_ids))
$body$;
REVOKE ALL ON FUNCTION platform_execution_allowed(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_execution_allowed(uuid,uuid,uuid,uuid) TO ao_runtime,ao_worker;
