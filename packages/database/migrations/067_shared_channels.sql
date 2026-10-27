CREATE TABLE shared_channel_grants (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces, conversation_id uuid NOT NULL,
 host_organization_id uuid NOT NULL REFERENCES organizations, organization_id uuid NOT NULL REFERENCES organizations,
 source_workspace_id uuid NOT NULL REFERENCES workspaces, invited_by uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 policy jsonb NOT NULL, host_policy_version integer NOT NULL, source_policy_version integer NOT NULL,
 state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','active','revoked')),
 version integer NOT NULL DEFAULT 1, accepted_by uuid REFERENCES accounts, accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,invited_by) REFERENCES memberships(workspace_id,id),
 CHECK(host_organization_id<>organization_id),
 FOREIGN KEY(host_organization_id,workspace_id) REFERENCES workspaces(organization_id,id),
 FOREIGN KEY(organization_id,source_workspace_id) REFERENCES workspaces(organization_id,id)
);
CREATE UNIQUE INDEX shared_active_organization ON shared_channel_grants(workspace_id,conversation_id,organization_id) WHERE state<>'revoked';
ALTER TABLE memberships ADD COLUMN external_organization_id uuid REFERENCES organizations;
ALTER TABLE memberships ADD CONSTRAINT external_membership_guest CHECK(external_organization_id IS NULL OR (access_type='guest' AND kind='human' AND role='member'));
CREATE TABLE shared_channel_participants (
 workspace_id uuid NOT NULL, grant_id uuid NOT NULL, membership_id uuid NOT NULL,
 source_workspace_id uuid NOT NULL, source_membership_id uuid NOT NULL,
 source_auth_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,grant_id,membership_id),
 FOREIGN KEY(workspace_id,grant_id) REFERENCES shared_channel_grants(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(source_workspace_id,source_membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE OR REPLACE FUNCTION enroll_organization_member() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE org uuid;
BEGIN
 IF NEW.kind='human' AND NEW.external_organization_id IS NULL THEN
 SELECT organization_id INTO org FROM workspaces WHERE id=NEW.workspace_id;
 INSERT INTO organization_members(organization_id,account_id,role)
 SELECT org,NEW.account_id,CASE WHEN NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org) THEN 'owner' ELSE 'member' END
 WHERE NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org AND account_id=NEW.account_id)
 ON CONFLICT(organization_id,account_id) DO NOTHING;
 END IF;
 RETURN NEW;
END
$body$;
DO $body$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['shared_channel_grants','shared_channel_participants'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_identity,ao_worker',t);
 EXECUTE format('CREATE POLICY identity_boundary ON %I TO ao_identity USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE POLICY worker_boundary ON %I TO ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',t);
 END LOOP;
END
$body$;
CREATE TABLE shared_channel_policies (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, policy jsonb NOT NULL,
 PRIMARY KEY(workspace_id,conversation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
ALTER TABLE shared_channel_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_channel_policies FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON shared_channel_policies TO ao_identity;
GRANT SELECT ON shared_channel_policies TO ao_worker;
CREATE POLICY identity_boundary ON shared_channel_policies TO ao_identity USING(true) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY worker_boundary ON shared_channel_policies TO ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

CREATE FUNCTION external_channel_current(tenant uuid,member uuid,conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND (EXISTS(SELECT 1 FROM public.memberships own WHERE own.workspace_id=tenant AND own.id=member AND own.external_organization_id IS NULL)
 OR EXISTS(SELECT 1 FROM public.shared_channel_participants p
 JOIN public.shared_channel_grants g ON g.workspace_id=p.workspace_id AND g.id=p.grant_id
 JOIN public.memberships m ON m.workspace_id=p.source_workspace_id AND m.id=p.source_membership_id
 JOIN public.workspaces source_workspace ON source_workspace.id=m.workspace_id AND source_workspace.organization_id=g.organization_id
 JOIN public.accounts a ON a.id=m.account_id
 JOIN public.organization_members om ON om.organization_id=g.organization_id AND om.account_id=a.id
 JOIN public.organizations source ON source.id=g.organization_id JOIN public.organizations host ON host.id=g.host_organization_id
 WHERE p.workspace_id=tenant AND p.membership_id=member AND g.conversation_id=conversation AND g.state='active'
 AND m.status='active' AND m.access_type='member' AND om.status='active' AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL
 AND a.auth_version=p.source_auth_version AND source.version=g.source_policy_version AND host.version=g.host_policy_version
 AND coalesce((m.permissions->>'messages.read')::boolean,true)
 AND (cardinality(source.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(source.allowed_domains))))
$body$;
REVOKE ALL ON FUNCTION external_channel_current(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION external_channel_current(uuid,uuid,uuid) TO ao_runtime,ao_worker,ao_identity;
CREATE OR REPLACE FUNCTION shared_conversation(conversation uuid) RETURNS boolean LANGUAGE sql STABLE AS $body$
 SELECT EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=conversation AND cm.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND external_channel_current(cm.workspace_id,cm.membership_id,conversation))
$body$;
CREATE FUNCTION shared_message_retained(tenant uuid,conversation uuid,created timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM public.shared_channel_grants g WHERE g.workspace_id=tenant AND g.conversation_id=conversation AND g.state='active' AND created<clock_timestamp()-(g.policy->>'retentionDays')::int*interval '1 day')
$body$;
REVOKE ALL ON FUNCTION shared_message_retained(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shared_message_retained(uuid,uuid,timestamptz) TO ao_runtime,ao_worker,ao_identity;
CREATE POLICY shared_retention ON messages AS RESTRICTIVE TO ao_runtime USING(shared_message_retained(workspace_id,conversation_id,created_at));
CREATE FUNCTION shared_agent_allowed(tenant uuid,conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM public.shared_channel_grants g WHERE g.workspace_id=tenant AND g.conversation_id=conversation AND g.state='active' AND NOT (g.policy->>'agents')::boolean)
$body$;
REVOKE ALL ON FUNCTION shared_agent_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shared_agent_allowed(uuid,uuid) TO ao_runtime,ao_worker,ao_identity;
CREATE FUNCTION shared_channel_grants_access(tenant uuid,conversation uuid) RETURNS TABLE(export_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT (g.policy->>'export')::boolean FROM public.shared_channel_grants g WHERE g.workspace_id=tenant AND g.conversation_id=conversation AND g.state='active' AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
REVOKE ALL ON FUNCTION shared_channel_grants_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shared_channel_grants_access(uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION member_external_attribution(tenant uuid,member uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('organizationId',o.id,'organizationName',o.name) FROM public.memberships m JOIN public.organizations o ON o.id=m.external_organization_id WHERE m.workspace_id=tenant AND m.id=member AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
REVOKE ALL ON FUNCTION member_external_attribution(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_external_attribution(uuid,uuid) TO ao_runtime,ao_worker;
GRANT EXECUTE ON FUNCTION migration_owner_current(uuid,uuid,integer,integer) TO ao_identity;
GRANT SELECT,UPDATE ON conversations TO ao_identity;
CREATE POLICY shared_identity_read ON conversations FOR SELECT TO ao_identity USING(true);
CREATE POLICY shared_identity_update ON conversations FOR UPDATE TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON conversation_members TO ao_identity;
CREATE POLICY shared_identity_read ON conversation_members FOR SELECT TO ao_identity USING(true);
CREATE POLICY shared_identity_insert ON conversation_members FOR INSERT TO ao_identity WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY shared_identity_delete ON conversation_members FOR DELETE TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT UPDATE ON retrieval_authority TO ao_identity;
CREATE POLICY shared_identity_invalidation ON retrieval_authority TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT DELETE ON retrieval_contexts TO ao_identity;
CREATE POLICY shared_identity_invalidation ON retrieval_contexts FOR DELETE TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT SELECT ON retrieval_authority,retrieval_contexts TO ao_identity;

CREATE OR REPLACE FUNCTION message_visible_to(tenant uuid,conversation uuid,message_sequence integer,root uuid,member uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.conversations c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=member AND m.status='active'
 LEFT JOIN public.conversation_members cm ON cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id
 WHERE c.workspace_id=tenant AND c.id=conversation
 AND (m.external_organization_id IS NULL OR public.external_channel_current(tenant,member,conversation)) AND (m.kind<>'agent' OR public.shared_agent_allowed(tenant,conversation))
 AND (message_sequence=2147483647 OR NOT EXISTS(SELECT 1 FROM public.shared_channel_policies policy WHERE policy.workspace_id=tenant AND policy.conversation_id=conversation) OR EXISTS(SELECT 1 FROM public.messages retained WHERE retained.workspace_id=tenant AND retained.conversation_id=conversation AND retained.sequence=message_sequence AND public.shared_message_retained(tenant,conversation,retained.created_at)))
 AND (cm.membership_id IS NOT NULL OR (c.visibility='public' AND m.access_type='member' AND c.history_policy='retained'))
 AND message_sequence>=coalesce(cm.history_from_sequence,0)
 AND (root IS NULL OR EXISTS(SELECT 1 FROM public.messages r WHERE r.workspace_id=tenant AND r.conversation_id=conversation AND r.id=root AND r.sequence>=coalesce(cm.history_from_sequence,0) AND public.shared_message_retained(tenant,conversation,r.created_at))))
$body$;
REVOKE ALL ON FUNCTION message_visible_to(uuid,uuid,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_visible_to(uuid,uuid,integer,uuid,uuid) TO ao_runtime,ao_worker;
CREATE OR REPLACE FUNCTION resource_visible_to(tenant uuid,conversation uuid,created timestamptz,member uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.memberships m WHERE m.workspace_id=tenant AND m.id=member AND m.status='active' AND (conversation IS NULL OR (m.external_organization_id IS NULL OR public.external_channel_current(tenant,member,conversation)) AND (m.kind<>'agent' OR public.shared_agent_allowed(tenant,conversation))) AND (
 (conversation IS NULL AND m.access_type='member') OR EXISTS(
 SELECT 1 FROM public.conversations c LEFT JOIN public.conversation_members cm ON cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id
 WHERE c.workspace_id=tenant AND c.id=conversation AND (cm.membership_id IS NOT NULL OR (c.visibility='public' AND m.access_type='member' AND c.history_policy='retained'))
 AND (coalesce(cm.history_from_sequence,0)=0 OR created>=cm.joined_at))))
$body$;
REVOKE ALL ON FUNCTION resource_visible_to(uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_visible_to(uuid,uuid,timestamptz,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION publish_shared_activity(tenant uuid,event bigint) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 INSERT INTO public.outbox_events(workspace_id,event_type,resource_id,audience_membership_id)
 SELECT p.source_workspace_id,'shared_channel.activity',g.id,p.source_membership_id FROM public.outbox_events e JOIN public.shared_channel_grants g ON g.workspace_id=e.workspace_id AND g.conversation_id=e.conversation_id JOIN public.shared_channel_participants p ON p.workspace_id=g.workspace_id AND p.grant_id=g.id WHERE e.workspace_id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND e.id=event AND e.event_type IN ('message.created','message.edited','message.deleted','message.reaction_changed','migration.message_imported','shared_channel.changed') AND g.state='active' AND public.external_channel_current(tenant,p.membership_id,g.conversation_id)
$body$;
REVOKE ALL ON FUNCTION publish_shared_activity(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_shared_activity(uuid,bigint) TO ao_runtime,ao_worker,ao_identity;
CREATE OR REPLACE FUNCTION shared_message_retained(tenant uuid,conversation uuid,created timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM public.shared_channel_policies p WHERE p.workspace_id=tenant AND p.conversation_id=conversation AND created<clock_timestamp()-(p.policy->>'retentionDays')::int*interval '1 day')
$body$;
CREATE OR REPLACE FUNCTION shared_channel_grants_access(tenant uuid,conversation uuid) RETURNS TABLE(export_allowed boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT (p.policy->>'export')::boolean FROM public.shared_channel_policies p WHERE p.workspace_id=tenant AND p.conversation_id=conversation AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
CREATE OR REPLACE FUNCTION shared_agent_allowed(tenant uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM public.shared_channel_policies p WHERE p.workspace_id=tenant AND p.conversation_id=conversation AND NOT (p.policy->>'agents')::boolean)
$body$;
