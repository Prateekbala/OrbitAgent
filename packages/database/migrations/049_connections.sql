CREATE TABLE connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
 owner_id uuid NOT NULL, provider text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 audience text NOT NULL CHECK(audience IN ('personal','workspace')), state text NOT NULL DEFAULT 'connected' CHECK(state IN ('connected','reconnect_required','revoked')),
 auth_version integer NOT NULL, policy_version integer NOT NULL, credential_expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days',
 version integer NOT NULL DEFAULT 1, config jsonb NOT NULL DEFAULT '{}', subscriptions text[] NOT NULL DEFAULT '{}',
 last_success_at timestamptz, last_error_code text, next_request_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE connection_secrets (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, encrypted_value text NOT NULL,
 generation integer NOT NULL DEFAULT 1, refresh_lease uuid, refresh_until timestamptz,
 rotated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,connection_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE connection_grants (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, member_id uuid NOT NULL,
 resources text[] NOT NULL CHECK(cardinality(resources) BETWEEN 1 AND 100), operations text[] NOT NULL CHECK(cardinality(operations) BETWEEN 1 AND 100),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 PRIMARY KEY(workspace_id,connection_id,member_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE connection_oauth_states (
 state_hash text PRIMARY KEY, workspace_id uuid NOT NULL, owner_id uuid NOT NULL, session_hash text NOT NULL,
 provider text NOT NULL, encrypted_verifier text NOT NULL, connection_id uuid, config jsonb NOT NULL, name text NOT NULL, audience text NOT NULL,
 auth_version integer NOT NULL, policy_version integer NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE connection_resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 500), operation text NOT NULL,
 conversation_id uuid, title text NOT NULL CHECK(length(title)<=500), body text NOT NULL CHECK(length(body)<=1000000),
 source_url text, language text NOT NULL DEFAULT 'und', provider_version text, version integer NOT NULL DEFAULT 1,
 retained_until timestamptz NOT NULL, deleted_at timestamptz, fetched_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,connection_id,external_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE connection_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
 provider_event_id text NOT NULL CHECK(length(provider_event_id)<=250), kind text NOT NULL,
 payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','dead')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease uuid, lease_until timestamptz,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,connection_id,provider_event_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id)
);
CREATE TABLE connector_validations (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, operation text NOT NULL, environment text NOT NULL CHECK(environment IN ('fixture','provider_test')),
 validated_by uuid NOT NULL, evidence text NOT NULL CHECK(length(evidence) BETWEEN 10 AND 2000), validated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connection_id,operation,environment),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
 FOREIGN KEY(workspace_id,validated_by) REFERENCES memberships(workspace_id,id)
);
CREATE FUNCTION connection_access(tenant uuid,target uuid,member uuid,owner_only boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.connections c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=member
 JOIN public.memberships owner ON owner.workspace_id=c.workspace_id AND owner.id=c.owner_id
 WHERE c.workspace_id=tenant AND c.id=target AND m.status='active' AND owner.status='active' AND owner.kind='human' AND owner.access_type='member'
 AND m.access_type='member' AND (c.owner_id=m.id OR (NOT owner_only AND c.audience='workspace' AND c.state='connected' AND EXISTS(
 SELECT 1 FROM public.connection_grants g WHERE g.workspace_id=tenant AND g.connection_id=c.id AND g.member_id=m.id AND g.revoked_at IS NULL AND g.expires_at>now()))))
$$;
CREATE FUNCTION connection_authority_current(tenant uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.connections c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=c.owner_id
 JOIN public.accounts a ON a.id=m.account_id JOIN public.workspaces w ON w.id=c.workspace_id JOIN public.organizations o ON o.id=w.organization_id
 JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=a.id
 WHERE c.workspace_id=tenant AND c.id=target AND c.state='connected' AND c.credential_expires_at>now()
 AND m.status='active' AND m.kind='human' AND m.access_type='member' AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND om.status='active'
 AND a.auth_version=c.auth_version AND o.version=c.policy_version
 AND coalesce((m.permissions->>'execution.manage')::boolean,true) AND coalesce((m.permissions->>'knowledge.read')::boolean,true)
 AND (cardinality(o.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(o.allowed_domains)))
$$;
REVOKE ALL ON FUNCTION connection_authority_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connection_authority_current(uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION connection_resource_access(tenant uuid,target uuid,member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.connection_resources r JOIN public.connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id
 WHERE r.workspace_id=tenant AND r.id=target AND r.deleted_at IS NULL AND r.retained_until>now() AND c.state='connected' AND c.credential_expires_at>now()
 AND public.connection_authority_current(tenant,c.id) AND public.connection_access(tenant,c.id,member) AND public.resource_visible_to(tenant,r.conversation_id,r.created_at,member)
 AND (c.owner_id=member OR EXISTS(SELECT 1 FROM public.connection_grants g WHERE g.workspace_id=tenant AND g.connection_id=c.id AND g.member_id=member AND g.revoked_at IS NULL AND g.expires_at>now() AND r.external_id=ANY(g.resources) AND r.operation=ANY(g.operations))))
$$;
REVOKE ALL ON FUNCTION connection_access(uuid,uuid,uuid,boolean),connection_resource_access(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connection_access(uuid,uuid,uuid,boolean),connection_resource_access(uuid,uuid,uuid) TO ao_runtime,ao_worker;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['connections','connection_secrets','connection_grants','connection_oauth_states','connection_resources','connection_events','connector_validations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE POLICY connection_audience ON connections AS RESTRICTIVE FOR SELECT TO ao_runtime USING(connection_access(workspace_id,id,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY secret_owner ON connection_secrets AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true)) WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
CREATE POLICY grant_owner ON connection_grants AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true) OR member_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
CREATE POLICY oauth_owner ON connection_oauth_states AS RESTRICTIVE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY resource_audience ON connection_resources AS RESTRICTIVE FOR SELECT TO ao_runtime USING(connection_resource_access(workspace_id,id,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY event_owner ON connection_events AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
CREATE POLICY validation_owner ON connector_validations AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
CREATE INDEX connection_event_dispatch ON connection_events(workspace_id,available_at) WHERE state IN ('pending','leased');
CREATE INDEX connection_resource_scope ON connection_resources(workspace_id,connection_id,external_id);
CREATE POLICY connection_insert ON connections AS RESTRICTIVE FOR INSERT TO ao_runtime WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY connection_update ON connections AS RESTRICTIVE FOR UPDATE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY connection_delete ON connections AS RESTRICTIVE FOR DELETE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE FUNCTION connection_import_access(tenant uuid,target uuid,member uuid,resource text,operation text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=tenant AND c.id=target AND c.state='connected' AND c.credential_expires_at>now() AND public.connection_authority_current(tenant,target) AND public.connection_access(tenant,target,member) AND (c.owner_id=member OR EXISTS(SELECT 1 FROM public.connection_grants g WHERE g.workspace_id=tenant AND g.connection_id=target AND g.member_id=member AND g.revoked_at IS NULL AND g.expires_at>now() AND resource=ANY(g.resources) AND operation=ANY(g.operations))))
$$;
REVOKE ALL ON FUNCTION connection_import_access(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION connection_import_access(uuid,uuid,uuid,text,text) TO ao_runtime,ao_worker;
DROP POLICY resource_audience ON connection_resources;
CREATE POLICY resource_audience ON connection_resources AS RESTRICTIVE FOR SELECT TO ao_runtime USING(deleted_at IS NULL AND retained_until>now() AND connection_import_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,external_id,operation) AND resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY resource_insert ON connection_resources AS RESTRICTIVE FOR INSERT TO ao_runtime WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
CREATE POLICY resource_update ON connection_resources AS RESTRICTIVE FOR UPDATE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true)) WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
