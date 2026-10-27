CREATE TABLE governance_policies(organization_id uuid PRIMARY KEY REFERENCES organizations,version integer NOT NULL,policy jsonb NOT NULL,updated_by uuid NOT NULL REFERENCES accounts,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE governance_revisions(organization_id uuid NOT NULL REFERENCES organizations,version integer NOT NULL,policy jsonb NOT NULL,actor_id uuid NOT NULL REFERENCES accounts,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,version));
CREATE TABLE egress_attestations(organization_id uuid NOT NULL REFERENCES organizations,service text NOT NULL,provider text NOT NULL,region text NOT NULL,evidence text NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(organization_id,service,provider));
CREATE TABLE security_audit_heads(organization_id uuid PRIMARY KEY REFERENCES organizations,sequence bigint NOT NULL DEFAULT 0,hash text NOT NULL DEFAULT repeat('0',64));
CREATE TABLE security_audit(organization_id uuid NOT NULL REFERENCES organizations,sequence bigint NOT NULL,previous_hash text NOT NULL,content_hash text NOT NULL,hash text NOT NULL,source_id uuid NOT NULL,source text NOT NULL,workspace_id uuid,actor_id uuid,action text NOT NULL,resource_id text NOT NULL,conversation_id uuid,audience_id uuid,occurred_at timestamptz NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(organization_id,sequence),UNIQUE(source,source_id));
CREATE INDEX security_audit_action ON security_audit(organization_id,action,sequence);
CREATE TABLE support_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,account_id uuid NOT NULL REFERENCES accounts,approved_by uuid NOT NULL REFERENCES accounts,workspace_ids uuid[] NOT NULL,purpose text NOT NULL,ticket text NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK(account_id<>approved_by));
CREATE TABLE legal_holds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,workspace_id uuid NOT NULL,conversation_id uuid,reason text NOT NULL,reference text NOT NULL,created_by uuid NOT NULL REFERENCES accounts,created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,released_by uuid REFERENCES accounts,release_reason text,FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id),FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id));
CREATE INDEX legal_hold_active ON legal_holds(workspace_id,conversation_id) WHERE released_at IS NULL;
DO $body$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['governance_policies','governance_revisions','egress_attestations','security_audit_heads','security_audit','support_grants','legal_holds'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO ao_identity',t);EXECUTE format('CREATE POLICY trusted_identity ON %I TO ao_identity USING(true) WITH CHECK(true)',t);
END LOOP;END $body$;
REVOKE INSERT,UPDATE ON security_audit,security_audit_heads,egress_attestations FROM ao_identity;
REVOKE UPDATE ON governance_revisions FROM ao_identity;
CREATE FUNCTION governance_policy(tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT coalesce(p.policy,'{}'::jsonb) FROM public.workspaces w LEFT JOIN public.governance_policies p ON p.organization_id=w.organization_id WHERE w.id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
CREATE FUNCTION governance_egress(tenant uuid,service_name text,provider_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.workspaces w JOIN public.organizations o ON o.id=w.organization_id LEFT JOIN public.governance_policies p ON p.organization_id=o.id WHERE w.id=tenant AND (NOT coalesce((p.policy->>'attestedEgress')::boolean,false) OR EXISTS(SELECT 1 FROM public.egress_attestations a WHERE a.organization_id=o.id AND a.service=service_name AND a.provider=provider_name AND a.expires_at>now() AND a.region=ANY(o.allowed_regions))))
$body$;
CREATE FUNCTION governance_held(tenant uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=tenant AND h.released_at IS NULL AND (h.conversation_id IS NULL OR h.conversation_id=conversation))
$body$;
REVOKE ALL ON FUNCTION governance_policy(uuid),governance_egress(uuid,text,text),governance_held(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance_policy(uuid),governance_egress(uuid,text,text),governance_held(uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION enforce_governance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE p jsonb;item jsonb;tenant uuid;selected text;permitted boolean:=true;BEGIN
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
  permitted:=coalesce((p->>'hostedExecution')::boolean,true) AND (jsonb_array_length(coalesce(p->'models','[]'))=0 OR p->'models'?selected) AND coalesce(p->>'byok','optional')<>'required' AND public.governance_egress(tenant,'runtime',selected);
 END IF;
 WHEN 'tool_invocations' THEN IF NEW.status IN ('pending','approved','executing') THEN permitted:=(jsonb_array_length(coalesce(p->'tools','[]'))=0 OR p->'tools'?NEW.tool_name) AND public.governance_egress(tenant,'tool',NEW.tool_name);END IF;
 WHEN 'connections' THEN IF NEW.state='connected' THEN permitted:=coalesce((p->>'connections')::boolean,true) AND (jsonb_array_length(coalesce(p->'connectionProviders','[]'))=0 OR p->'connectionProviders'?NEW.provider) AND public.governance_egress(tenant,'connection',NEW.provider);END IF;
 WHEN 'calls' THEN IF NEW.state='active' THEN permitted:=coalesce(p->'recordingModes','["no_recording","transient_captions","retained_recording"]')?NEW.mode AND public.governance_egress(tenant,'media','livekit');END IF;
 WHEN 'memory_releases' THEN permitted:=coalesce((p->>'internalSharing')::boolean,true);
 WHEN 'file_shares' THEN permitted:=coalesce((p->>'internalSharing')::boolean,true);
 WHEN 'shared_channel_grants' THEN IF NEW.state<>'revoked' THEN permitted:=coalesce((p->>'externalSharing')::boolean,true);END IF;
 ELSE RETURN NEW;END CASE;
 IF permitted IS DISTINCT FROM true THEN RAISE EXCEPTION 'Organization governance denied this operation' USING ERRCODE='AOG01';END IF;RETURN NEW;
END $body$;
CREATE TRIGGER governance_admission BEFORE INSERT ON agents FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER governance_admission BEFORE INSERT OR UPDATE OF status ON agent_runs FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER governance_admission BEFORE INSERT OR UPDATE OF status ON tool_invocations FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER governance_admission BEFORE INSERT OR UPDATE OF state,provider ON connections FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER governance_admission BEFORE INSERT OR UPDATE OF state,mode,recording_state ON calls FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER governance_admission BEFORE INSERT ON file_shares FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE FUNCTION append_security_audit(org uuid,source_name text,item jsonb,workspace uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE record jsonb;prior public.security_audit_heads;content text;next_hash text;BEGIN
 INSERT INTO public.security_audit_heads(organization_id) VALUES(org) ON CONFLICT DO NOTHING;
 SELECT * INTO prior FROM public.security_audit_heads WHERE organization_id=org FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.security_audit WHERE source=source_name AND source_id=(item->>'id')::uuid) THEN RETURN;END IF;
 record:=jsonb_build_object('source',source_name,'sourceId',item->>'id','workspaceId',workspace,'actorId',item->>'actor_id','action',item->>'action','resourceId',item->>'resource_id','conversationId',item->>'conversation_id','audienceId',item->>'audience_membership_id','occurredAt',item->>'created_at');
 content:=encode(sha256(convert_to(record::text,'UTF8')),'hex');next_hash:=encode(sha256(convert_to(prior.hash||content||(prior.sequence+1)::text||org::text,'UTF8')),'hex');
 INSERT INTO public.security_audit VALUES(org,prior.sequence+1,prior.hash,content,next_hash,(item->>'id')::uuid,source_name,workspace,(item->>'actor_id')::uuid,item->>'action',item->>'resource_id',(item->>'conversation_id')::uuid,(item->>'audience_membership_id')::uuid,(item->>'created_at')::timestamptz,record);
 UPDATE public.security_audit_heads SET sequence=prior.sequence+1,hash=next_hash WHERE organization_id=org;
END $body$;
REVOKE ALL ON FUNCTION append_security_audit(uuid,text,jsonb,uuid) FROM PUBLIC;
CREATE FUNCTION capture_security_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE org uuid;workspace uuid;item jsonb:=to_jsonb(NEW);BEGIN
 IF TG_TABLE_NAME='organization_audit' THEN org:=NEW.organization_id;ELSE workspace:=NEW.workspace_id;SELECT organization_id INTO org FROM public.workspaces WHERE id=workspace;END IF;
 PERFORM public.append_security_audit(org,TG_TABLE_NAME,item,workspace);RETURN NULL;
END $body$;
DO $body$ DECLARE r record;BEGIN
 FOR r IN SELECT w.organization_id org,'audit_events' source,to_jsonb(a) item,a.workspace_id workspace,a.created_at occurred,a.id FROM public.audit_events a JOIN public.workspaces w ON w.id=a.workspace_id
 UNION ALL SELECT a.organization_id,'organization_audit',to_jsonb(a),NULL::uuid,a.created_at,a.id FROM public.organization_audit a ORDER BY occurred,source,id LOOP
 PERFORM public.append_security_audit(r.org,r.source,r.item,r.workspace);
 END LOOP;
END $body$;
CREATE TRIGGER security_audit_capture AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION capture_security_audit();
CREATE TRIGGER security_audit_capture AFTER INSERT ON organization_audit FOR EACH ROW EXECUTE FUNCTION capture_security_audit();
CREATE FUNCTION immutable_security_record() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'Immutable security record' USING ERRCODE='42501';END $body$;
CREATE TRIGGER immutable_security_record BEFORE UPDATE OR DELETE ON security_audit FOR EACH ROW EXECUTE FUNCTION immutable_security_record();
CREATE TRIGGER immutable_security_record BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_security_record();
CREATE TRIGGER immutable_security_record BEFORE UPDATE OR DELETE ON organization_audit FOR EACH ROW EXECUTE FUNCTION immutable_security_record();
CREATE FUNCTION preserve_held_content() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item jsonb;tenant uuid;conversation uuid;BEGIN
 item:=to_jsonb(OLD);tenant:=(item->>'workspace_id')::uuid;conversation:=(item->>'conversation_id')::uuid;
 IF tenant IS NULL THEN RAISE EXCEPTION 'Invalid held content scope' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.workspaces WHERE id=tenant FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=tenant AND h.released_at IS NULL AND (h.conversation_id IS NULL OR h.conversation_id=conversation)) AND (TG_OP='DELETE' OR
 (TG_TABLE_NAME='messages' AND (to_jsonb(NEW)->'body' IS DISTINCT FROM item->'body' OR to_jsonb(NEW)->'deleted_at' IS DISTINCT FROM item->'deleted_at')) OR
 (TG_TABLE_NAME='files' AND (to_jsonb(NEW)->'sha256' IS DISTINCT FROM item->'sha256' OR to_jsonb(NEW)->>'status' IN ('deleting','deleted','rejected'))) OR
 (TG_TABLE_NAME='retained_transcripts' AND (to_jsonb(NEW)->'body' IS DISTINCT FROM item->'body' OR to_jsonb(NEW)->'deleted_at' IS DISTINCT FROM item->'deleted_at')) OR
 (TG_TABLE_NAME='calls' AND (to_jsonb(NEW)->'notes' IS DISTINCT FROM item->'notes' OR to_jsonb(NEW)->'recording_deleted_at' IS DISTINCT FROM item->'recording_deleted_at')) OR
 (TG_TABLE_NAME='tasks' AND (to_jsonb(NEW)->'title' IS DISTINCT FROM item->'title' OR to_jsonb(NEW)->'description' IS DISTINCT FROM item->'description' OR to_jsonb(NEW)->'acceptance_criteria' IS DISTINCT FROM item->'acceptance_criteria')) OR
 (TG_TABLE_NAME='knowledge_pages' AND (to_jsonb(NEW)->'body' IS DISTINCT FROM item->'body' OR to_jsonb(NEW)->'title' IS DISTINCT FROM item->'title'))) THEN RAISE EXCEPTION 'Content is under legal hold' USING ERRCODE='AOG02';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $body$;
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION preserve_held_content();
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON files FOR EACH ROW EXECUTE FUNCTION preserve_held_content();
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON knowledge_pages FOR EACH ROW EXECUTE FUNCTION preserve_held_content();
CREATE TRIGGER governance_admission BEFORE INSERT OR UPDATE OF state ON shared_channel_grants FOR EACH ROW EXECUTE FUNCTION enforce_governance();
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON retained_transcripts FOR EACH ROW EXECUTE FUNCTION preserve_held_content();
CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON calls FOR EACH ROW EXECUTE FUNCTION preserve_held_content();
CREATE FUNCTION support_diagnostics(org uuid,workspaces uuid[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object('workspaceId',w.id,'runs',(SELECT coalesce(jsonb_object_agg(s.status,s.total),'{}') FROM(SELECT status,count(*) total FROM public.agent_runs WHERE workspace_id=w.id GROUP BY status)s),'tools',(SELECT coalesce(jsonb_object_agg(s.status,s.total),'{}') FROM(SELECT status,count(*) total FROM public.tool_invocations WHERE workspace_id=w.id GROUP BY status)s))),'[]') FROM public.workspaces w WHERE w.organization_id=org AND w.id=ANY(workspaces)
$body$;
CREATE FUNCTION legal_hold_available(org uuid,workspace uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.workspaces WHERE organization_id=org AND id=workspace) AND NOT EXISTS(SELECT 1 FROM public.files f WHERE f.workspace_id=workspace AND (conversation IS NULL OR f.conversation_id=conversation) AND f.status='deleting' AND f.purged_at IS NULL)
$body$;
CREATE FUNCTION audit_resource_disclosable(tenant uuid,conversation uuid,audience uuid,created timestamptz,account uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=tenant AND m.account_id=account AND m.status='active' AND m.access_type='member' AND (audience IS NULL OR audience=m.id) AND public.resource_visible_to(tenant,conversation,created,m.id))
$body$;
REVOKE ALL ON FUNCTION support_diagnostics(uuid,uuid[]),legal_hold_available(uuid,uuid,uuid),audit_resource_disclosable(uuid,uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_diagnostics(uuid,uuid[]),legal_hold_available(uuid,uuid,uuid),audit_resource_disclosable(uuid,uuid,uuid,timestamptz,uuid) TO ao_identity;
CREATE FUNCTION lock_governance_workspaces(org uuid,target uuid DEFAULT NULL) RETURNS TABLE(id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT w.id FROM public.workspaces w WHERE w.organization_id=org AND (target IS NULL OR w.id=target) ORDER BY w.id FOR UPDATE $body$;
REVOKE ALL ON FUNCTION lock_governance_workspaces(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION lock_governance_workspaces(uuid,uuid) TO ao_identity;

CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION preserve_held_content();

CREATE FUNCTION preserve_held_child() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item jsonb:=to_jsonb(OLD);tenant uuid:=(item->>'workspace_id')::uuid;conversation uuid;BEGIN
 PERFORM 1 FROM public.workspaces WHERE id=tenant FOR SHARE;
 IF item?'page_id' THEN SELECT conversation_id INTO conversation FROM public.knowledge_pages WHERE workspace_id=tenant AND id=(item->>'page_id')::uuid;
 ELSE SELECT conversation_id INTO conversation FROM public.tasks WHERE workspace_id=tenant AND id=(item->>'task_id')::uuid;END IF;
 IF EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=tenant AND h.released_at IS NULL AND (h.conversation_id IS NULL OR h.conversation_id=conversation)) THEN RAISE EXCEPTION 'Content is under legal hold' USING ERRCODE='AOG02';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $body$;
DO $body$ DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['task_comments','task_artifacts','task_criteria','task_criterion_reviews','knowledge_documents','knowledge_versions','knowledge_comments','knowledge_reviews','knowledge_proposals'] LOOP EXECUTE format('CREATE TRIGGER legal_hold_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION preserve_held_child()',name);END LOOP;END $body$;
REVOKE ALL ON FUNCTION preserve_held_child() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_governance(),capture_security_audit(),preserve_held_content() FROM PUBLIC;

CREATE TRIGGER governance_admission BEFORE INSERT ON memory_releases FOR EACH ROW EXECUTE FUNCTION enforce_governance();
