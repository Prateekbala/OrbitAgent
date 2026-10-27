DO $body$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_model_broker') THEN CREATE ROLE ao_model_broker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END $body$;
GRANT USAGE ON SCHEMA public TO ao_model_broker;
CREATE TABLE organization_model_keys(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations,provider text NOT NULL CHECK(provider='openai'),label text NOT NULL,generation integer NOT NULL DEFAULT 1,models text[] NOT NULL,sealed_key text NOT NULL,wrapping_key_id text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_by uuid NOT NULL REFERENCES accounts,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,provider),CHECK(cardinality(models) BETWEEN 1 AND 100));
ALTER TABLE organization_model_keys ENABLE ROW LEVEL SECURITY;ALTER TABLE organization_model_keys FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON organization_model_keys TO ao_identity;
CREATE POLICY identity_model_keys ON organization_model_keys TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT ON organization_model_keys TO ao_model_broker;
CREATE POLICY broker_model_keys ON organization_model_keys TO ao_model_broker USING(true);
CREATE TABLE byok_runs(workspace_id uuid NOT NULL,run_id uuid NOT NULL,organization_id uuid NOT NULL REFERENCES organizations,key_id uuid NOT NULL REFERENCES organization_model_keys,key_generation integer NOT NULL,model text NOT NULL,state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','completed','uncertain','cancelled')),result jsonb,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,run_id),FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id));
ALTER TABLE byok_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE byok_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT ON byok_runs TO ao_worker;
CREATE POLICY byok_run_worker ON byok_runs TO ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON byok_runs TO ao_model_broker;
CREATE POLICY byok_run_broker ON byok_runs TO ao_model_broker USING(true) WITH CHECK(true);
CREATE POLICY organization_erasure_fence ON byok_runs AS RESTRICTIVE TO ao_worker USING(organization_live(workspace_id)) WITH CHECK(organization_live(workspace_id));
CREATE FUNCTION byok_route(tenant uuid,model_name text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('required',coalesce(g.policy->>'byok','optional')='required','disabled',coalesce(g.policy->>'byok','optional')='disabled','organizationId',w.organization_id,'keyId',k.id,'generation',k.generation) FROM public.workspaces w LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id LEFT JOIN public.organization_model_keys k ON k.organization_id=w.organization_id AND k.revoked_at IS NULL AND k.expires_at>now() AND model_name=ANY(k.models) WHERE w.id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND public.organization_live(tenant)
$body$;
REVOKE ALL ON FUNCTION byok_route(uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION byok_route(uuid,text) TO ao_worker,ao_runtime,ao_model_broker;
CREATE OR REPLACE FUNCTION governance_byok_ready(tenant uuid,model_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.workspaces w LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id WHERE w.id=tenant AND (coalesce(g.policy->>'byok','optional')<>'required' OR EXISTS(SELECT 1 FROM public.organization_model_keys k WHERE k.organization_id=w.organization_id AND k.revoked_at IS NULL AND k.expires_at>now() AND model_name=ANY(k.models))))
$body$;
REVOKE ALL ON FUNCTION governance_byok_ready(uuid,text) FROM PUBLIC;
CREATE FUNCTION broker_run_authority(tenant uuid,target uuid,key uuid,generation integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT current_setting('role',true)='ao_model_broker' AND EXISTS(SELECT 1 FROM public.agent_runs r JOIN public.workspaces w ON w.id=r.workspace_id JOIN public.organization_model_keys k ON k.organization_id=w.organization_id LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id WHERE r.workspace_id=tenant AND r.id=target AND r.status='running' AND r.dispatch_started AND r.lease_expires_at>now() AND k.id=key AND k.generation=generation AND k.revoked_at IS NULL AND k.expires_at>now() AND r.configuration->>'model'=ANY(k.models) AND coalesce(g.policy->>'byok','optional')<>'disabled' AND public.organization_live(tenant))
$body$;

REVOKE ALL ON FUNCTION broker_run_authority(uuid,uuid,uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION broker_run_authority(uuid,uuid,uuid,integer) TO ao_model_broker;
CREATE OR REPLACE FUNCTION public.enforce_governance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE p jsonb;item jsonb;tenant uuid;selected text;permitted boolean:=true;BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 item:=to_jsonb(NEW);tenant:=(item->>'workspace_id')::uuid;
 SELECT policy INTO p FROM public.governance_policies g JOIN public.workspaces w ON w.organization_id=g.organization_id WHERE w.id=tenant;
 IF TG_TABLE_NAME='shared_channel_grants' AND item->>'state'<>'revoked' THEN
  IF EXISTS(SELECT 1 FROM public.governance_policies WHERE organization_id=(item->>'organization_id')::uuid AND NOT coalesce((policy->>'externalSharing')::boolean,true)) THEN RAISE EXCEPTION 'Organization governance denied this operation' USING ERRCODE='AOG01';END IF;
 END IF;
 IF p IS NULL THEN RETURN NEW;END IF;
 CASE TG_TABLE_NAME
 WHEN 'agents' THEN IF TG_OP='INSERT' THEN permitted:=coalesce((p->>'agentCreation')::boolean,true);END IF;
 WHEN 'agent_runs' THEN IF NEW.status IN ('queued','running') THEN
  selected:=coalesce(NEW.configuration->>'model','operator_default');
  permitted:=coalesce((p->>'hostedExecution')::boolean,true) AND (jsonb_array_length(coalesce(p->'models','[]'))=0 OR p->'models'?selected) AND public.governance_byok_ready(tenant,selected) AND public.governance_egress(tenant,'runtime',selected);
 END IF;
 WHEN 'tool_invocations' THEN IF NEW.status IN ('pending','approved','executing') THEN permitted:=(jsonb_array_length(coalesce(p->'tools','[]'))=0 OR p->'tools'?NEW.tool_name) AND public.governance_egress(tenant,'tool',NEW.tool_name);END IF;
 WHEN 'connections' THEN IF NEW.state='connected' THEN permitted:=coalesce((p->>'connections')::boolean,true) AND (jsonb_array_length(coalesce(p->'connectionProviders','[]'))=0 OR p->'connectionProviders'?NEW.provider) AND public.governance_egress(tenant,'connection',NEW.provider);END IF;
 WHEN 'calls' THEN IF NEW.state='active' THEN permitted:=coalesce(p->'recordingModes','["no_recording","transient_captions","retained_recording"]')?NEW.mode AND public.governance_egress(tenant,'media','livekit');END IF;
 WHEN 'memory_releases' THEN permitted:=coalesce((p->>'internalSharing')::boolean,true);
 WHEN 'file_shares' THEN permitted:=coalesce((p->>'internalSharing')::boolean,true);
 WHEN 'shared_channel_grants' THEN IF NEW.state<>'revoked' THEN permitted:=coalesce((p->>'externalSharing')::boolean,true);END IF;
 ELSE RETURN NEW;END CASE;
 IF permitted IS DISTINCT FROM true THEN RAISE EXCEPTION 'Organization governance denied this operation' USING ERRCODE='AOG01';END IF;RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION purge_organization_database(target uuid,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE job public.organization_erasures;t record;fk_column record;remaining text[];next_tables text[];changed integer;progress integer;total bigint:=0;workspace uuid;retained text[]:=ARRAY['workspaces','memberships','sessions','audit_events','security_audit','legal_holds'];BEGIN
 IF current_setting('role',true)<>'ao_erasure' THEN RAISE EXCEPTION 'Erasure authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM public.organization_erasures WHERE id=target AND lease=fence AND lease_until>now() AND state='purging' FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Erasure lease expired' USING ERRCODE='AOG03';END IF;
 PERFORM 1 FROM public.organizations WHERE id=job.organization_id FOR UPDATE;
 PERFORM set_config('ao.erasure_job',target::text,true);PERFORM set_config('ao.erasure_lease',fence::text,true);
 FOREACH workspace IN ARRAY job.workspace_ids LOOP IF NOT public.organization_erasure_authorized(workspace) THEN RAISE EXCEPTION 'Preservation must be resolved before erasure' USING ERRCODE='AOG02';END IF;END LOOP;
 IF job.storage_deleted_at IS NULL THEN RAISE EXCEPTION 'Physical storage acknowledgement required' USING ERRCODE='AOG04';END IF;
 IF job.database_deleted_at IS NOT NULL THEN RETURN jsonb_build_object('alreadyDeleted',true);END IF;
 UPDATE public.shared_channel_grants SET state='revoked',revoked_at=coalesce(revoked_at,now()),version=version+1 WHERE (organization_id=job.organization_id OR host_organization_id=job.organization_id) AND state<>'revoked';
 UPDATE public.memberships SET status='suspended',name='[erased external member]' WHERE external_organization_id=job.organization_id;
 DELETE FROM public.deletion_receipts WHERE job_id IN(SELECT id FROM public.lifecycle_jobs WHERE organization_id=job.organization_id);
 DELETE FROM public.legal_holds WHERE organization_id=job.organization_id AND released_at IS NOT NULL;
 SELECT array_agg(c.relname ORDER BY c.relname) INTO remaining FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT(c.relname=ANY(retained)) AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped);
 FOREACH workspace IN ARRAY job.workspace_ids LOOP
  PERFORM set_config('ao.workspace_id',workspace::text,true);
  FOR fk_column IN SELECT DISTINCT cl.relname,a.attname FROM pg_constraint k JOIN pg_class cl ON cl.oid=k.conrelid JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum=ANY(k.conkey) WHERE k.contype='f' AND cl.relname=ANY(remaining) AND NOT a.attnotnull AND a.attname<>'workspace_id' LOOP
   BEGIN EXECUTE format('UPDATE public.%I SET %I=NULL WHERE workspace_id=$1 AND %I IS NOT NULL',fk_column.relname,fk_column.attname,fk_column.attname) USING workspace; EXCEPTION WHEN check_violation OR not_null_violation THEN NULL;END;
  END LOOP;
 END LOOP;
 WHILE coalesce(cardinality(remaining),0)>0 LOOP
  next_tables:='{}';progress:=0;
  FOREACH workspace IN ARRAY job.workspace_ids LOOP PERFORM set_config('ao.workspace_id',workspace::text,true);END LOOP;
  FOR t IN SELECT unnest(remaining) name LOOP
   BEGIN
    EXECUTE format('DELETE FROM public.%I WHERE workspace_id=ANY($1)',t.name) USING job.workspace_ids;
    GET DIAGNOSTICS changed=ROW_COUNT;total:=total+changed;progress:=progress+1;
   EXCEPTION WHEN foreign_key_violation THEN next_tables:=array_append(next_tables,t.name);
   END;
  END LOOP;
  IF progress=0 THEN RAISE EXCEPTION 'Unresolved erasure dependency: %',next_tables USING ERRCODE='AOG04';END IF;
  remaining:=next_tables;
 END LOOP;
 DELETE FROM public.federation_transactions WHERE provider_id IN(SELECT id FROM public.identity_providers WHERE organization_id=job.organization_id);
 DELETE FROM public.saml_request_ids WHERE provider_id IN(SELECT id FROM public.identity_providers WHERE organization_id=job.organization_id);
 DELETE FROM public.federated_identities WHERE provider_id IN(SELECT id FROM public.identity_providers WHERE organization_id=job.organization_id);
 DELETE FROM public.sessions WHERE workspace_id=ANY(job.workspace_ids) AND account_id<>job.requested_by;
 UPDATE public.sessions SET provider_id=NULL WHERE provider_id IN(SELECT id FROM public.identity_providers WHERE organization_id=job.organization_id);
 DELETE FROM public.identity_providers WHERE organization_id=job.organization_id;
 UPDATE public.scim_credentials SET revoked_at=coalesce(revoked_at,now()),label='[erased]' WHERE organization_id=job.organization_id;
 DELETE FROM public.scim_group_members WHERE organization_id=job.organization_id;
 DELETE FROM public.scim_groups WHERE organization_id=job.organization_id;
 DELETE FROM public.organization_model_keys WHERE organization_id=job.organization_id;
 DELETE FROM public.organization_domains WHERE organization_id=job.organization_id;
 DELETE FROM public.support_grants WHERE organization_id=job.organization_id;
 DELETE FROM public.egress_attestations WHERE organization_id=job.organization_id;
 DELETE FROM public.product_metrics WHERE organization_id=job.organization_id;
 UPDATE public.organization_members SET external_id=NULL,display_name=NULL WHERE organization_id=job.organization_id;
 UPDATE public.memberships SET name='[erased member]' WHERE workspace_id=ANY(job.workspace_ids);
 UPDATE public.workspaces SET name='[erased workspace]',storage_bytes=0 WHERE id=ANY(job.workspace_ids);
 UPDATE public.organizations SET name='[erased organization]',allowed_domains='{}',require_sso=false WHERE id=job.organization_id;
 UPDATE public.organization_erasures SET database_deleted_at=now(),storage_deleted_at=now(),state='waiting_receipts' WHERE id=target;
 INSERT INTO public.organization_audit(id,organization_id,actor_id,action,resource_id) VALUES(gen_random_uuid(),job.organization_id,NULL,'organization.database_erased',target::text);
 PERFORM set_config('ao.erasure_job','',true);PERFORM set_config('ao.erasure_lease','',true);
 RETURN jsonb_build_object('deletedRows',total,'retained',ARRAY['global accounts','organization/workspace/member tombstones','security audit metadata','financial accounting']);
END $body$;
ALTER TABLE agent_runs ADD COLUMN model_key_id uuid REFERENCES organization_model_keys;
ALTER TABLE agent_runs ADD COLUMN model_key_generation integer;
CREATE FUNCTION bind_run_model_key() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE mode text;credential public.organization_model_keys;BEGIN
 SELECT coalesce(g.policy->>'byok','optional') INTO mode FROM public.workspaces w LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id WHERE w.id=NEW.workspace_id;
 NEW.model_key_id:=NULL;NEW.model_key_generation:=NULL;
 IF mode<>'disabled' THEN SELECT k.* INTO credential FROM public.organization_model_keys k JOIN public.workspaces w ON w.organization_id=k.organization_id WHERE w.id=NEW.workspace_id AND k.revoked_at IS NULL AND k.expires_at>now() AND NEW.configuration->>'model'=ANY(k.models);NEW.model_key_id:=credential.id;NEW.model_key_generation:=credential.generation;END IF;
 RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION bind_run_model_key() FROM PUBLIC;
CREATE TRIGGER a_bind_model_key BEFORE INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION bind_run_model_key();
CREATE FUNCTION broker_run_credential(tenant uuid,target uuid,key uuid,generation integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('organizationId',k.organization_id,'sealedKey',k.sealed_key,'configuration',r.configuration,'model',r.configuration->>'model') FROM public.agent_runs r JOIN public.organization_model_keys k ON k.id=r.model_key_id WHERE r.workspace_id=tenant AND r.id=target AND r.status='running' AND r.model_key_id=key AND r.model_key_generation=generation AND public.broker_run_authority(tenant,target,key,generation)
$body$;
REVOKE ALL ON FUNCTION broker_run_credential(uuid,uuid,uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION broker_run_credential(uuid,uuid,uuid,integer) TO ao_model_broker;
REVOKE SELECT ON organization_model_keys FROM ao_model_broker;
CREATE FUNCTION run_model_route(tenant uuid,target uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('organizationId',w.organization_id,'keyId',r.model_key_id,'generation',r.model_key_generation,'required',coalesce(g.policy->>'byok','optional')='required','disabled',coalesce(g.policy->>'byok','optional')='disabled') FROM public.agent_runs r JOIN public.workspaces w ON w.id=r.workspace_id LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id WHERE tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND r.workspace_id=tenant AND r.id=target AND public.organization_live(tenant)
$body$;
REVOKE ALL ON FUNCTION run_model_route(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION run_model_route(uuid,uuid) TO ao_worker;
ALTER TABLE byok_runs ADD COLUMN request_hash text NOT NULL;
CREATE POLICY broker_tenant_boundary ON byok_runs AS RESTRICTIVE TO ao_model_broker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE OR REPLACE FUNCTION broker_run_authority(tenant uuid,target uuid,key uuid,generation integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT current_setting('role',true)='ao_model_broker' AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.agent_runs r JOIN public.workspaces w ON w.id=r.workspace_id JOIN public.organizations o ON o.id=w.organization_id JOIN public.agents a ON a.workspace_id=r.workspace_id AND a.id=r.agent_id JOIN public.memberships requester ON requester.workspace_id=r.workspace_id AND requester.id=r.requester_id JOIN public.accounts account ON account.id=requester.account_id JOIN public.memberships agent ON agent.workspace_id=a.workspace_id AND agent.id=a.membership_id JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=account.id JOIN public.organization_model_keys k ON k.organization_id=w.organization_id LEFT JOIN public.governance_policies g ON g.organization_id=w.organization_id
 WHERE r.workspace_id=tenant AND r.id=target AND r.status IN ('running','outcome_unknown') AND r.dispatch_started AND (r.status='outcome_unknown' OR r.lease_expires_at>now()) AND r.model_key_id=key AND r.model_key_generation=generation AND k.id=key AND k.generation=generation AND k.revoked_at IS NULL AND k.expires_at>now() AND r.configuration->>'model'=ANY(k.models)
 AND requester.status='active' AND requester.access_type='member' AND om.status='active' AND agent.status='active' AND a.status='active' AND a.revision=r.agent_revision AND account.disabled_at IS NULL AND account.email_verified_at IS NOT NULL AND account.auth_version=r.requester_auth_version AND o.version=r.requester_policy_version
 AND coalesce((g.policy->>'hostedExecution')::boolean,true) AND (jsonb_array_length(coalesce(g.policy->'models','[]'))=0 OR g.policy->'models'?(r.configuration->>'model')) AND coalesce(g.policy->>'byok','optional')<>'disabled' AND public.organization_live(tenant)
 AND public.resource_visible_to(tenant,r.conversation_id,r.created_at,requester.id) AND public.resource_visible_to(tenant,r.conversation_id,r.created_at,agent.id)
 AND (r.retrieval_epoch IS NULL OR r.retrieval_epoch=(SELECT epoch FROM public.retrieval_authority WHERE workspace_id=tenant)))
$body$;

CREATE FUNCTION immutable_model_binding() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
 IF public.organization_erasure_authorized(OLD.workspace_id) THEN RETURN NEW;END IF;
 IF (NEW.model_key_id,NEW.model_key_generation) IS DISTINCT FROM (OLD.model_key_id,OLD.model_key_generation) THEN RAISE EXCEPTION 'Run model binding is immutable' USING ERRCODE='42501';END IF;RETURN NEW;
END $body$;
CREATE TRIGGER immutable_model_binding BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION immutable_model_binding();
CREATE OR REPLACE FUNCTION legal_hold_available(org uuid,workspace uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.workspaces WHERE organization_id=org AND id=workspace) AND NOT EXISTS(SELECT 1 FROM public.files f WHERE f.workspace_id=workspace AND (conversation IS NULL OR f.conversation_id=conversation) AND f.status='deleting' AND f.purged_at IS NULL) AND NOT EXISTS(SELECT 1 FROM public.organization_erasures j WHERE j.organization_id=org AND j.state IN ('purging','waiting_receipts','completed','dead'))
$body$;
CREATE FUNCTION deny_erased_organization_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE org uuid;item jsonb:=to_jsonb(NEW);BEGIN
 org:=coalesce((item->>'organization_id')::uuid,(item->>'id')::uuid);
 IF EXISTS(SELECT 1 FROM public.organization_erasures WHERE organization_id=org) AND NOT(current_setting('role',true)='ao_erasure' AND EXISTS(SELECT 1 FROM public.organization_erasures j WHERE j.organization_id=org AND j.id=nullif(current_setting('ao.erasure_job',true),'')::uuid AND j.lease=nullif(current_setting('ao.erasure_lease',true),'')::uuid AND j.lease_until>now())) THEN RAISE EXCEPTION 'Organization deletion is in progress' USING ERRCODE='AOG01';END IF;
 RETURN NEW;
END $body$;
DO $body$ DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['organizations','organization_members','organization_domains','identity_providers','scim_groups','scim_credentials','governance_policies','support_grants','organization_model_keys'] LOOP EXECUTE format('CREATE TRIGGER erasure_configuration_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION deny_erased_organization_write()',name);END LOOP;END $body$;
CREATE TRIGGER erasure_workspace_guard BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION deny_erased_organization_write();
REVOKE ALL ON FUNCTION deny_erased_organization_write() FROM PUBLIC;
CREATE FUNCTION recover_byok_result(target uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT b.result FROM public.byok_runs b JOIN public.agent_runs r ON r.workspace_id=b.workspace_id AND r.id=b.run_id JOIN public.workspaces w ON w.id=r.workspace_id JOIN public.organizations o ON o.id=w.organization_id JOIN public.organization_model_keys k ON k.id=b.key_id JOIN public.memberships m ON m.workspace_id=r.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid
 WHERE r.id=target AND r.workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid AND m.status='active' AND m.access_type='member' AND (m.id=r.requester_id OR m.role IN ('owner','admin')) AND r.status='outcome_unknown' AND b.state='completed' AND k.revoked_at IS NULL AND k.expires_at>now() AND k.generation=b.key_generation AND o.version=r.requester_policy_version AND public.organization_live(r.workspace_id) AND public.resource_visible_to(r.workspace_id,r.conversation_id,r.created_at,m.id)
$body$;
REVOKE ALL ON FUNCTION recover_byok_result(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION recover_byok_result(uuid) TO ao_runtime;
GRANT EXECUTE ON FUNCTION organization_live(uuid) TO ao_identity;
