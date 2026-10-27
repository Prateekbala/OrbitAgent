DO $body$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ao_erasure') THEN CREATE ROLE ao_erasure NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END $body$;
GRANT USAGE ON SCHEMA public TO ao_erasure;
CREATE TABLE organization_erasures(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,request_key uuid NOT NULL,requested_by uuid NOT NULL REFERENCES accounts,reason text NOT NULL,workspace_ids uuid[] NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','held','purging','waiting_receipts','completed','dead')),manifest jsonb NOT NULL DEFAULT '[]',database_deleted_at timestamptz,storage_deleted_at timestamptz,backup_not_before timestamptz NOT NULL,lease uuid,lease_until timestamptz,failures integer NOT NULL DEFAULT 0,error_code text,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(organization_id),UNIQUE(organization_id,request_key));
CREATE TABLE organization_erasure_receipts(id text PRIMARY KEY,job_id uuid NOT NULL REFERENCES organization_erasures,processor text NOT NULL CHECK(processor IN ('backup','runtime','provider')),evidence_hash text NOT NULL,signature text NOT NULL,completed_at timestamptz NOT NULL,UNIQUE(job_id,processor));
ALTER TABLE organization_erasures ENABLE ROW LEVEL SECURITY;ALTER TABLE organization_erasures FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON organization_erasures TO ao_identity;
CREATE POLICY identity_erasure ON organization_erasures TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT ON organization_erasures TO ao_erasure;
CREATE POLICY erasure_jobs ON organization_erasures TO ao_erasure USING(true);
ALTER TABLE organization_erasure_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE organization_erasure_receipts FORCE ROW LEVEL SECURITY;
GRANT SELECT ON organization_erasure_receipts TO ao_identity,ao_erasure;
CREATE POLICY erasure_receipts ON organization_erasure_receipts TO ao_identity,ao_erasure USING(true);
CREATE TRIGGER immutable_erasure_receipt BEFORE UPDATE OR DELETE ON organization_erasure_receipts FOR EACH ROW EXECUTE FUNCTION immutable_security_record();
CREATE FUNCTION organization_live(tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=tenant AND NOT EXISTS(SELECT 1 FROM public.organization_erasures j WHERE j.organization_id=w.organization_id)) $body$;
REVOKE ALL ON FUNCTION organization_live(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION organization_live(uuid) TO ao_runtime,ao_worker;
DO $body$ DECLARE t record;BEGIN FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped) LOOP
 EXECUTE format('CREATE POLICY organization_erasure_fence ON public.%I AS RESTRICTIVE TO ao_runtime,ao_worker USING(public.organization_live(workspace_id)) WITH CHECK(public.organization_live(workspace_id))',t.relname);
 END LOOP;END $body$;
CREATE POLICY organization_erasure_fence ON workspaces AS RESTRICTIVE TO ao_runtime,ao_worker USING(organization_live(id)) WITH CHECK(organization_live(id));
CREATE FUNCTION organization_erasure_authorized(tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT current_setting('role',true)='ao_erasure' AND EXISTS(SELECT 1 FROM public.organization_erasures j WHERE j.id=nullif(current_setting('ao.erasure_job',true),'')::uuid AND j.lease=nullif(current_setting('ao.erasure_lease',true),'')::uuid AND j.lease_until>now() AND j.state='purging' AND tenant=ANY(j.workspace_ids) AND NOT EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=ANY(j.workspace_ids) AND h.released_at IS NULL) AND NOT EXISTS(SELECT 1 FROM public.knowledge_retention r WHERE r.workspace_id=ANY(j.workspace_ids) AND r.legal_hold))
$body$;
REVOKE ALL ON FUNCTION organization_erasure_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organization_erasure_authorized(uuid) TO ao_runtime,ao_worker,ao_identity,ao_erasure;
CREATE FUNCTION claim_organization_erasure() RETURNS SETOF organization_erasures LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 IF current_setting('role',true)<>'ao_erasure' THEN RAISE EXCEPTION 'Erasure authority required' USING ERRCODE='42501';END IF;
 RETURN QUERY UPDATE public.organization_erasures SET lease=gen_random_uuid(),lease_until=now()+interval '5 minutes' WHERE id IN(SELECT id FROM public.organization_erasures WHERE state IN ('pending','held','purging','waiting_receipts') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *;
END $body$;
CREATE FUNCTION prepare_organization_erasure(target uuid,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE job public.organization_erasures;items jsonb;BEGIN
 IF current_setting('role',true)<>'ao_erasure' THEN RAISE EXCEPTION 'Erasure authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM public.organization_erasures WHERE id=target AND lease=fence AND lease_until>now() FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Erasure lease expired' USING ERRCODE='AOG03';END IF;
 PERFORM 1 FROM public.organizations WHERE id=job.organization_id FOR UPDATE;
 PERFORM 1 FROM public.workspaces WHERE id=ANY(job.workspace_ids) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.legal_holds WHERE workspace_id=ANY(job.workspace_ids) AND released_at IS NULL) OR EXISTS(SELECT 1 FROM public.knowledge_retention WHERE workspace_id=ANY(job.workspace_ids) AND legal_hold) THEN UPDATE public.organization_erasures SET state='held' WHERE id=target;RETURN jsonb_build_object('held',true);END IF;
 IF job.created_at>now()-interval '3 minutes' THEN RETURN jsonb_build_object('deferred',true);END IF;
 IF job.manifest='[]' AND job.database_deleted_at IS NULL THEN
 SELECT coalesce(jsonb_agg(DISTINCT item),'[]') INTO items FROM (
 SELECT jsonb_build_object('kind','object','workspaceId',f.workspace_id,'provider',f.storage_provider,'key',f.object_key) item FROM public.files f WHERE f.workspace_id=ANY(job.workspace_ids)
 UNION ALL SELECT jsonb_build_object('kind','object','workspaceId',f.workspace_id,'provider',f.storage_provider,'key',f.preview_key) FROM public.files f WHERE f.workspace_id=ANY(job.workspace_ids) AND f.preview_key IS NOT NULL
 UNION ALL SELECT jsonb_build_object('kind','object','workspaceId',v.workspace_id,'provider',v.storage_provider,'key',v.object_key) FROM public.file_versions v JOIN public.files f ON f.workspace_id=v.workspace_id AND f.id=v.file_id WHERE v.workspace_id=ANY(job.workspace_ids)
 UNION ALL SELECT jsonb_build_object('kind','object','workspaceId',v.workspace_id,'provider',v.storage_provider,'key',v.preview_key) FROM public.file_versions v JOIN public.files f ON f.workspace_id=v.workspace_id AND f.id=v.file_id WHERE v.workspace_id=ANY(job.workspace_ids) AND v.preview_key IS NOT NULL
 UNION ALL SELECT jsonb_build_object('kind','object','workspaceId',c.workspace_id,'provider',f.storage_provider,'key',c.object_key) FROM public.file_upload_chunks c JOIN public.files f ON f.workspace_id=c.workspace_id AND f.id=c.file_id WHERE c.workspace_id=ANY(job.workspace_ids)
 UNION ALL SELECT jsonb_build_object('kind','room','workspaceId',workspace_id,'roomName',room_name) FROM public.calls WHERE workspace_id=ANY(job.workspace_ids) AND state<>'ended'
 UNION ALL SELECT jsonb_build_object('kind','media','workspaceId',workspace_id,'key',recording_key) FROM public.calls WHERE workspace_id=ANY(job.workspace_ids) AND recording_key IS NOT NULL
 UNION ALL SELECT jsonb_build_object('kind','runtime','workspaceId',workspace_id,'sessionId',session_id) FROM public.agent_runs WHERE workspace_id=ANY(job.workspace_ids) AND session_id IS NOT NULL
 ) inventory;
 UPDATE public.organization_erasures SET manifest=items WHERE id=target;job.manifest:=items;
 END IF;
 UPDATE public.organization_erasures SET state='purging' WHERE id=target;
 RETURN jsonb_build_object('held',false,'manifest',job.manifest,'databaseDeleted',job.database_deleted_at IS NOT NULL);
END $body$;

DO $body$ DECLARE constraint_name text;BEGIN FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='public.audit_events'::regclass AND confrelid='public.conversations'::regclass LOOP EXECUTE format('ALTER TABLE public.audit_events DROP CONSTRAINT %I',constraint_name);END LOOP;END $body$;
CREATE OR REPLACE FUNCTION public.agent_inbox_wakeup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.state<>'pending' OR TG_OP='UPDATE' AND OLD.state='pending' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.agents WHERE workspace_id=NEW.workspace_id AND id=NEW.agent_id AND runtime='managed') THEN
  INSERT INTO public.execution_policies(workspace_id,needs_work) VALUES(NEW.workspace_id,true) ON CONFLICT(workspace_id) DO UPDATE SET needs_work=true;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agents a JOIN public.agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision JOIN public.messages m ON m.workspace_id=NEW.workspace_id AND m.id=NEW.message_id WHERE a.workspace_id=NEW.workspace_id AND a.id=NEW.agent_id AND a.status='active' AND v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text)) THEN RETURN NEW; END IF;
 INSERT INTO public.outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id)
 SELECT NEW.workspace_id,'agent.inbox_ready',NEW.id,m.conversation_id,a.membership_id FROM public.agents a JOIN public.messages m ON m.workspace_id=NEW.workspace_id AND m.id=NEW.message_id WHERE a.id=NEW.agent_id AND a.workspace_id=NEW.workspace_id;
 INSERT INTO public.agent_wakeups(workspace_id,agent_id,inbox_id,webhook_version,generation)
 SELECT NEW.workspace_id,NEW.agent_id,NEW.id,w.version,NEW.fence FROM public.agent_webhooks w WHERE w.workspace_id=NEW.workspace_id AND w.agent_id=NEW.agent_id AND w.enabled ON CONFLICT DO NOTHING;
 RETURN NEW;
 END
$function$;
CREATE OR REPLACE FUNCTION public.capture_run_retrieval_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 SELECT epoch INTO NEW.retrieval_epoch FROM public.retrieval_authority WHERE workspace_id=NEW.workspace_id; RETURN NEW; END $function$;
CREATE OR REPLACE FUNCTION public.capture_security_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE org uuid;workspace uuid;item jsonb:=to_jsonb(NEW);BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='organization_audit' THEN org:=NEW.organization_id;ELSE workspace:=NEW.workspace_id;SELECT organization_id INTO org FROM public.workspaces WHERE id=workspace;END IF;
 PERFORM public.append_security_audit(org,TG_TABLE_NAME,item,workspace);RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.check_project_completion()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='projects' THEN PERFORM assert_project_completion(NEW.workspace_id,NEW.id);
 ELSE
  IF TG_TABLE_NAME='tasks' AND TG_OP='UPDATE' THEN IF NEW.version=OLD.version THEN RETURN NULL; END IF; END IF;
  PERFORM assert_project_completion(NEW.workspace_id,NEW.project_id);
 END IF;
 RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.check_task_graph()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='task_dependencies' THEN PERFORM assert_task_graph(NEW.workspace_id,NEW.task_id);
 ELSIF TG_OP='INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN PERFORM assert_task_graph(NEW.workspace_id,NEW.id);
 END IF;
 RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.commercial_media_meter()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF OLD.state='joined' AND NEW.state<>'joined' THEN PERFORM public.commercial_settle(NEW.workspace_id,'media',OLD.meter_reference,least(14400,greatest(0,ceil(extract(epoch FROM least(now(),OLD.expires_at)-OLD.meter_started_at))))::bigint,0,'participant_lease_seconds_not_priced');END IF;RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.commercial_seat_epoch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 UPDATE public.billing_accounts SET seat_epoch=seat_epoch+1 WHERE organization_id=(SELECT organization_id FROM public.workspaces WHERE id=coalesce(NEW.workspace_id,OLD.workspace_id));RETURN NULL;END $function$;
CREATE OR REPLACE FUNCTION public.commercial_tool_meter()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.status='executing' AND OLD.status<>'executing' THEN PERFORM public.commercial_reserve(NEW.workspace_id,'tools',NEW.id,1,0);END IF;
 IF NEW.status IN ('succeeded','failed','denied','expired') AND OLD.status IN ('executing','outcome_unknown') THEN PERFORM public.commercial_settle(NEW.workspace_id,'tools',NEW.id,1,0,'invocation_not_priced');END IF;RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.conversation_membership_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE floor integer; channel record;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='INSERT' THEN
  NEW.joined_at=clock_timestamp();
  SELECT c.* INTO channel FROM public.conversations c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.conversation_id;
  IF channel.kind='group' AND public.conversation_has_history(NEW.workspace_id,NEW.conversation_id) AND NOT EXISTS(SELECT 1 FROM public.conversation_members existing WHERE existing.workspace_id=NEW.workspace_id AND existing.conversation_id=NEW.conversation_id AND existing.membership_id=NEW.membership_id) THEN
   IF coalesce(current_setting('ao.group_membership_mutation',true),'')<>NEW.conversation_id::text THEN RAISE EXCEPTION 'Use group participant management to expand this audience' USING ERRCODE='AOM01'; END IF;
   IF coalesce(NEW.history_from_sequence,0)=0 AND NOT EXISTS(
    SELECT 1 FROM public.group_history_proposals h WHERE h.id=nullif(current_setting('ao.history_proposal_id',true),'')::uuid AND h.workspace_id=NEW.workspace_id AND h.conversation_id=NEW.conversation_id AND h.target_id=NEW.membership_id AND h.status='pending' AND h.base_version=channel.version AND h.expires_at>now()
    AND NOT EXISTS(SELECT 1 FROM unnest(h.voters) voter WHERE NOT EXISTS(SELECT 1 FROM public.group_history_votes v WHERE v.workspace_id=h.workspace_id AND v.proposal_id=h.id AND v.membership_id=voter AND v.decision='approve'))
    AND NOT EXISTS(SELECT 1 FROM public.conversation_members cm JOIN public.memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=h.workspace_id AND cm.conversation_id=h.conversation_id AND m.kind='human' AND m.status='active' AND NOT(m.id=ANY(h.voters)))
   ) THEN RAISE EXCEPTION 'Participant consent is required for earlier history' USING ERRCODE='AOM02'; END IF;
  END IF;
  IF NEW.history_from_sequence IS NULL THEN
   SELECT CASE WHEN c.history_policy='join_time' THEN c.next_sequence+1 ELSE 0 END INTO floor FROM public.conversations c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.conversation_id;
   NEW.history_from_sequence=coalesce(floor,0);
  END IF;
  INSERT INTO public.conversation_membership_intervals(workspace_id,conversation_id,membership_id,history_from_sequence,joined_at) VALUES(NEW.workspace_id,NEW.conversation_id,NEW.membership_id,NEW.history_from_sequence,NEW.joined_at) ON CONFLICT DO NOTHING;
  RETURN NEW;
 END IF;
 UPDATE public.conversation_membership_intervals SET left_at=now() WHERE workspace_id=OLD.workspace_id AND conversation_id=OLD.conversation_id AND membership_id=OLD.membership_id AND left_at IS NULL;
 RETURN OLD;
END
$function$;
CREATE OR REPLACE FUNCTION public.count_product_outcome()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE org uuid;BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.action NOT IN ('task.transitioned','run.completed','approval.approved','approval.rejected','knowledge.published','message.created') THEN RETURN NULL;END IF;
 SELECT w.organization_id INTO org FROM public.workspaces w JOIN public.governance_policies p ON p.organization_id=w.organization_id WHERE w.id=NEW.workspace_id AND (p.policy->>'analytics')::boolean;
 IF org IS NOT NULL THEN INSERT INTO public.product_metrics VALUES(org,current_date,NEW.action,1) ON CONFLICT(organization_id,day,event) DO UPDATE SET total=product_metrics.total+1;END IF;RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.enforce_commercial_seats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE account public.billing_accounts;limit_seats integer;used integer;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.kind<>'human' OR NEW.status<>'active' OR NEW.access_type<>'member' THEN RETURN NEW;END IF;
 SELECT a.* INTO account FROM public.billing_accounts a JOIN public.workspaces w ON w.organization_id=a.organization_id WHERE w.id=NEW.workspace_id FOR UPDATE OF a;
 IF account.mode='self_hosted' THEN RETURN NEW;END IF;
 SELECT human_seats INTO limit_seats FROM public.billing_plans WHERE id=CASE WHEN account.status='trialing' AND account.trial_ends_at>now() THEN 'team' WHEN account.status='active' THEN account.plan_id ELSE 'free' END AND revision=1;
 SELECT count(*)::int INTO used FROM(SELECT DISTINCT m.account_id FROM public.memberships m JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.accounts a ON a.id=m.account_id WHERE w.organization_id=account.organization_id AND m.status='active' AND m.kind='human' AND m.access_type='member' AND a.disabled_at IS NULL AND m.id<>NEW.id UNION SELECT NEW.account_id) seats;
 IF used>limit_seats THEN RAISE EXCEPTION 'Human seat allowance exceeded' USING ERRCODE='AOB01';END IF;RETURN NEW;
END $function$;
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
END $function$;
CREATE OR REPLACE FUNCTION public.enroll_organization_member()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE org uuid;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.kind='human' AND NEW.external_organization_id IS NULL THEN
 SELECT organization_id INTO org FROM workspaces WHERE id=NEW.workspace_id;
 INSERT INTO organization_members(organization_id,account_id,role)
 SELECT org,NEW.account_id,CASE WHEN NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org) THEN 'owner' ELSE 'member' END
 WHERE NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org AND account_id=NEW.account_id)
 ON CONFLICT(organization_id,account_id) DO NOTHING;
 END IF;
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.guard_execution_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.run_id<>OLD.run_id OR NEW.amount_micros<>OLD.amount_micros OR NEW.created_at<>OLD.created_at OR OLD.state<>'reserved' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Spending reservations have immutable identity and terminal settlements' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
 END
$function$;
CREATE OR REPLACE FUNCTION public.guard_file_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.conversation_id,NEW.task_id,NEW.uploader_id,NEW.client_id) IS DISTINCT FROM (OLD.workspace_id,OLD.conversation_id,OLD.task_id,OLD.uploader_id,OLD.client_id) THEN RAISE EXCEPTION 'Immutable file source'; END IF;
 IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND t.conversation_id IS NOT DISTINCT FROM NEW.conversation_id) THEN RAISE EXCEPTION 'Task file audience mismatch'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_imported_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.source_attribution IS NOT NULL THEN NEW.source_attribution=jsonb_set(jsonb_set(NEW.source_attribution,'{reactions}','[]'::jsonb),'{files}','[]'::jsonb); END IF;
 IF OLD.source_attribution IS NOT NULL AND EXISTS(SELECT 1 FROM public.migration_sources s WHERE s.workspace_id=OLD.workspace_id AND s.id=(OLD.source_attribution->>'sourceId')::uuid AND s.conflict_owner='source') AND NEW.deleted_at IS NULL AND (NEW.body,NEW.format) IS DISTINCT FROM (OLD.body,OLD.format)
 AND coalesce(current_setting('ao.import_source',true),'')<>coalesce(OLD.source_attribution->>'sourceId','') THEN
  RAISE EXCEPTION 'Imported messages require explicit conflict resolution' USING ERRCODE='AOM11';
 END IF;
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.guard_message_file_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF EXISTS(SELECT 1 FROM files WHERE workspace_id=NEW.workspace_id AND id=NEW.file_id AND task_id IS NOT NULL) THEN RAISE EXCEPTION 'Task files cannot be attached to messages'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_organization_entity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM lock_task_graph(NEW.workspace_id);
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.created_by,NEW.created_at,NEW.client_id,NEW.request_hash) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.created_by,OLD.created_at,OLD.client_id,OLD.request_hash) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid organization revision'; END IF;
  IF TG_TABLE_NAME='projects' THEN IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN RAISE EXCEPTION 'Immutable project audience'; END IF; END IF;
  IF TG_TABLE_NAME='project_milestones' THEN IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'Immutable milestone project'; END IF; END IF;
  NEW.updated_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.state='completed' AND EXISTS(SELECT 1 FROM task_criteria WHERE workspace_id=NEW.workspace_id AND task_id=NEW.id AND required AND NOT accepted) THEN RAISE EXCEPTION 'Required acceptance criteria are unverified' USING ERRCODE='AOT05'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_attachment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' AND ((NEW.workspace_id,NEW.task_id,NEW.file_id,NEW.attached_by,NEW.attached_at) IS DISTINCT FROM (OLD.workspace_id,OLD.task_id,OLD.file_id,OLD.attached_by,OLD.attached_at) OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Invalid attachment removal'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_comment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.creation_body_hash IS DISTINCT FROM OLD.creation_body_hash OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Task comment identity and deleted content are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.guard_task_dependency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM lock_task_graph(COALESCE(NEW.workspace_id,OLD.workspace_id));
 RETURN COALESCE(NEW,OLD);
END;
$function$;
CREATE OR REPLACE FUNCTION public.guard_task_label()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN PERFORM lock_task_graph(OLD.workspace_id); RETURN OLD; END IF;
 PERFORM lock_task_graph(NEW.workspace_id);
 IF EXISTS(SELECT 1 FROM work_labels WHERE workspace_id=NEW.workspace_id AND id=NEW.label_id AND archived) THEN RAISE EXCEPTION 'Archived label cannot be assigned' USING ERRCODE='AOP06'; END IF;
 IF (SELECT count(*) FROM task_label_links WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id)>=20 THEN RAISE EXCEPTION 'A task supports at most 20 labels' USING ERRCODE='AOP07'; END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_organization()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE project projects%ROWTYPE; milestone project_milestones%ROWTYPE; placement boolean;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.version=OLD.version AND (NEW.project_id,NEW.milestone_id) IS NOT DISTINCT FROM (OLD.project_id,OLD.milestone_id) THEN RETURN NEW; END IF;
 END IF;
 PERFORM lock_task_graph(NEW.workspace_id);
 placement=TG_OP='INSERT';
 IF TG_OP='UPDATE' THEN
  placement=(NEW.project_id,NEW.milestone_id) IS DISTINCT FROM (OLD.project_id,OLD.milestone_id);
  IF placement AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Task placement requires a new version'; END IF;
 END IF;
 IF NEW.project_id IS NOT NULL THEN
  SELECT * INTO project FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id;
  IF project.id IS NULL OR project.conversation_id IS DISTINCT FROM NEW.conversation_id THEN RAISE EXCEPTION 'Project and task audiences must match' USING ERRCODE='AOP01'; END IF;
  IF placement AND project.status IN ('completed','archived') THEN RAISE EXCEPTION 'Project is closed' USING ERRCODE='AOP02'; END IF;
 END IF;
 IF NEW.milestone_id IS NOT NULL THEN
  SELECT * INTO milestone FROM project_milestones WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.milestone_id;
  IF milestone.id IS NULL THEN RAISE EXCEPTION 'Milestone must belong to the task project' USING ERRCODE='AOP01'; END IF;
  IF placement AND milestone.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Milestone is closed' USING ERRCODE='AOP03'; END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.time_zone) THEN RAISE EXCEPTION 'Unknown time zone'; END IF;
 IF NEW.local_time::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:00$' THEN RAISE EXCEPTION 'Minute precision is required'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.task_id) IS DISTINCT FROM (OLD.workspace_id,OLD.task_id) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid schedule revision'; END IF;
  IF TG_TABLE_NAME='task_recurrences' THEN
   IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Immutable recurrence identity'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.guard_task_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.create_request_id IS DISTINCT FROM OLD.create_request_id OR NEW.create_request_hash IS DISTINCT FROM OLD.create_request_hash THEN
   RAISE EXCEPTION 'Task identity, creator and audience are immutable' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.title,NEW.description,NEW.priority,NEW.assignee_id,NEW.parent_id,NEW.due_date,NEW.state) IS DISTINCT FROM ROW(OLD.title,OLD.description,OLD.priority,OLD.assignee_id,OLD.parent_id,OLD.due_date,OLD.state) AND NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'Task changes require a new version' USING ERRCODE='23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
   IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Task versions advance one step' USING ERRCODE='23514'; END IF;
   PERFORM lock_task_graph(NEW.workspace_id);
   NEW.updated_at=clock_timestamp();
  END IF;
 ELSE
  PERFORM lock_task_graph(NEW.workspace_id);
 END IF;
 RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.immutable_agent_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF; RAISE EXCEPTION 'Agent revisions are immutable' USING ERRCODE='23514'; END
$function$;
CREATE OR REPLACE FUNCTION public.immutable_automation_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF; RAISE EXCEPTION 'Automation revisions are immutable' USING ERRCODE='23514'; END
$function$;
CREATE OR REPLACE FUNCTION public.immutable_run_record()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF; RAISE EXCEPTION 'Run checkpoints and traces are append-only' USING ERRCODE='23514'; END
$function$;
CREATE OR REPLACE FUNCTION public.immutable_security_record()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF; RAISE EXCEPTION 'Immutable security record' USING ERRCODE='42501';END $function$;
CREATE OR REPLACE FUNCTION public.immutable_tool_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF; RAISE EXCEPTION 'Action events are immutable' USING ERRCODE='23514'; END $function$;
CREATE OR REPLACE FUNCTION public.initialize_knowledge_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 INSERT INTO knowledge_metadata(workspace_id,page_id,conversation_id,created_at,owner_id) SELECT NEW.workspace_id,NEW.id,NEW.conversation_id,NEW.created_at,coalesce((SELECT owner_id FROM agents WHERE workspace_id=NEW.workspace_id AND membership_id=NEW.author_id),NEW.author_id);RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.invalidate_file_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='files' AND NEW.sha256=OLD.sha256 AND NEW.dlp_status=OLD.dlp_status AND NEW.dlp_policy_version=OLD.dlp_policy_version THEN RETURN NULL;END IF;
 UPDATE public.retrieval_authority SET epoch=epoch+1 WHERE workspace_id=NEW.workspace_id;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=NEW.workspace_id;
 UPDATE public.files f SET retrieval_version=greatest(f.retrieval_version,coalesce((SELECT e.version FROM public.file_extractions e WHERE e.workspace_id=f.workspace_id AND e.file_id=f.id),0))+1 WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.id;
 DELETE FROM public.file_extractions WHERE workspace_id=NEW.workspace_id AND (TG_TABLE_NAME='file_dlp_policies' OR file_id=NEW.id);
 UPDATE public.agent_memories SET deleted_at=now() WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL AND sources @> '[{"kind":"file"}]'::jsonb;
 RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public.invalidate_file_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 UPDATE public.retrieval_authority SET epoch=epoch+1 WHERE workspace_id=NEW.workspace_id;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=NEW.workspace_id;
 UPDATE public.files f SET retrieval_version=greatest(f.retrieval_version,coalesce((SELECT e.version FROM public.file_extractions e WHERE e.workspace_id=f.workspace_id AND e.file_id=f.id),0))+1 WHERE f.workspace_id=NEW.workspace_id;
 DELETE FROM public.file_extractions WHERE workspace_id=NEW.workspace_id;
 UPDATE public.agent_memories SET deleted_at=now() WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL AND sources @> '[{"kind":"file"}]'::jsonb;
 RETURN NULL;END $function$;
CREATE OR REPLACE FUNCTION public.invalidate_retrieval_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE tenant uuid; BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='connections' AND TG_OP='INSERT' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='connections' AND TG_OP='UPDATE' THEN
  IF (NEW.state,NEW.owner_id,NEW.audience,NEW.version,NEW.write_enabled) IS NOT DISTINCT FROM (OLD.state,OLD.owner_id,OLD.audience,OLD.version,OLD.write_enabled) THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='memberships' AND TG_OP='UPDATE' THEN
  IF NEW.status=OLD.status AND NEW.access_type=OLD.access_type AND NEW.permissions=OLD.permissions AND
   array_position(ARRAY['member','admin','owner'],NEW.role)>=array_position(ARRAY['member','admin','owner'],OLD.role) THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='workspaces' THEN tenant:=NEW.id;
 ELSIF TG_OP='DELETE' THEN tenant:=OLD.workspace_id; ELSE tenant:=NEW.workspace_id;END IF;
 INSERT INTO public.retrieval_authority(workspace_id) VALUES(tenant) ON CONFLICT(workspace_id) DO UPDATE SET epoch=public.retrieval_authority.epoch+1;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=tenant;
 INSERT INTO public.outbox_events(workspace_id,event_type,resource_id) VALUES(tenant,'retrieval.invalidated',tenant);
 RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public.notify_connection_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.state='completed' AND OLD.state<>'completed' THEN
 INSERT INTO public.connection_deliveries(workspace_id,connection_id,event_id,webhook_version)
 SELECT NEW.workspace_id,NEW.connection_id,NEW.id,w.version FROM public.connection_webhooks w WHERE w.workspace_id=NEW.workspace_id AND w.connection_id=NEW.connection_id AND w.enabled AND w.endpoint IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.offboard_connected_authority()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE revoke_owner boolean;BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 revoke_owner:=NEW.status<>'active' OR NEW.access_type<>'member' OR NEW.permissions->>'execution.manage'='false' OR NEW.permissions->>'knowledge.read'='false';
 IF NEW.status<>'active' OR NEW.access_type<>'member' THEN
  UPDATE public.connection_grants SET revoked_at=now() WHERE workspace_id=NEW.workspace_id AND member_id=NEW.id AND revoked_at IS NULL;
 END IF;
 IF revoke_owner THEN
  UPDATE public.connections SET state='revoked',version=version+1,last_error_code='OWNER_AUTHORITY_REVOKED',updated_at=now() WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id AND state<>'revoked';
  DELETE FROM public.connection_secrets s WHERE s.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=s.workspace_id AND c.id=s.connection_id AND c.owner_id=NEW.id);
  DELETE FROM public.connection_oauth_states WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id;
  UPDATE public.connection_webhooks w SET enabled=false,encrypted_incoming='',encrypted_outgoing='',version=version+1 WHERE w.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=w.workspace_id AND c.id=w.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_resources r SET deleted_at=now(),body='',title='Removed resource',version=version+1 WHERE r.workspace_id=NEW.workspace_id AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=r.workspace_id AND c.id=r.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_events e SET state='dead',error_code='OWNER_AUTHORITY_REVOKED',payload='{}',lease=NULL,lease_until=NULL WHERE e.workspace_id=NEW.workspace_id AND e.state IN ('pending','leased') AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=e.workspace_id AND c.id=e.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_deliveries d SET state='dead',error_code='OWNER_AUTHORITY_REVOKED',lease=NULL,lease_until=NULL WHERE d.workspace_id=NEW.workspace_id AND d.state IN ('pending','sending') AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=d.workspace_id AND c.id=d.connection_id AND c.owner_id=NEW.id);
 END IF;
 IF NEW.status<>'active' OR NEW.access_type<>'member' THEN DELETE FROM public.agent_memories WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id;END IF;
 RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.preserve_held_child()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE item jsonb:=to_jsonb(OLD);tenant uuid:=(item->>'workspace_id')::uuid;conversation uuid;BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 PERFORM 1 FROM public.workspaces WHERE id=tenant FOR SHARE;
 IF item?'page_id' THEN SELECT conversation_id INTO conversation FROM public.knowledge_pages WHERE workspace_id=tenant AND id=(item->>'page_id')::uuid;
 ELSE SELECT conversation_id INTO conversation FROM public.tasks WHERE workspace_id=tenant AND id=(item->>'task_id')::uuid;END IF;
 IF EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=tenant AND h.released_at IS NULL AND (h.conversation_id IS NULL OR h.conversation_id=conversation)) THEN RAISE EXCEPTION 'Content is under legal hold' USING ERRCODE='AOG02';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.preserve_held_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE item jsonb;tenant uuid;conversation uuid;BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
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
END $function$;
CREATE OR REPLACE FUNCTION public.propagate_canonical_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF (NEW.review_state,NEW.superseded_by) IS NOT DISTINCT FROM (OLD.review_state,OLD.superseded_by) THEN RETURN NEW;END IF;
 IF NEW.review_state IN ('stale','contradicted') OR NEW.superseded_by IS NOT NULL THEN
 WITH RECURSIVE derived(id) AS (SELECT page_id FROM public.knowledge_sources WHERE workspace_id=NEW.workspace_id AND source_page_id=NEW.page_id UNION SELECT s.page_id FROM public.knowledge_sources s JOIN derived d ON s.source_page_id=d.id WHERE s.workspace_id=NEW.workspace_id)
 UPDATE public.knowledge_metadata SET review_state='stale',blocked=blocked OR NEW.review_state='contradicted',version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id IN(SELECT id FROM derived) AND (review_state<>'stale' OR NEW.review_state='contradicted' AND NOT blocked);
 UPDATE public.knowledge_sources SET stale=true WHERE workspace_id=NEW.workspace_id AND source_page_id=NEW.page_id;
 UPDATE public.knowledge_proposals p SET status='invalidated' WHERE p.workspace_id=NEW.workspace_id AND p.status='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.sources) s WHERE s->>'id'=NEW.page_id::text);
 END IF;RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.propagate_knowledge_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE deleted boolean := false; target uuid; source_kind text; BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='knowledge_metadata' AND pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='messages' THEN deleted:=NEW.deleted_at IS NOT NULL;target:=NEW.id;source_kind:='message';
 ELSIF TG_TABLE_NAME='knowledge_metadata' THEN
  IF NEW.state=OLD.state AND NEW.blocked=OLD.blocked THEN RETURN NEW;END IF;
  deleted:=NEW.state IN ('deleted','archived') OR NEW.blocked;target:=NEW.page_id;source_kind:='page';
 ELSE target:=NEW.id;source_kind:='page';
 UPDATE public.knowledge_metadata SET review_state=CASE WHEN review_state IN ('approved','in_review') THEN 'draft' ELSE review_state END,version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id=target;
 END IF;
 WITH RECURSIVE derived(id) AS (
 SELECT s.page_id FROM public.knowledge_sources s WHERE s.workspace_id=NEW.workspace_id AND
 ((source_kind='message' AND s.source_message_id=target) OR (source_kind='page' AND s.source_page_id=target))
 UNION SELECT s.page_id FROM public.knowledge_sources s JOIN derived d ON s.source_page_id=d.id WHERE s.workspace_id=NEW.workspace_id
 ) UPDATE public.knowledge_metadata SET review_state='stale',blocked=blocked OR deleted,version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id IN(SELECT id FROM derived) AND (review_state<>'stale' OR deleted AND NOT blocked);
 UPDATE public.knowledge_sources s SET stale=true WHERE s.workspace_id=NEW.workspace_id AND ((source_kind='message' AND s.source_message_id=target) OR (source_kind='page' AND s.source_page_id=target));
 UPDATE public.knowledge_proposals p SET status='invalidated' WHERE p.workspace_id=NEW.workspace_id AND p.status='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.sources) s WHERE (source_kind='message' AND s->>'messageId'=target::text) OR (source_kind='page' AND s->>'id'=target::text));
 RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.protect_knowledge_metadata()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF (NEW.workspace_id,NEW.page_id,NEW.conversation_id,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.page_id,OLD.conversation_id,OLD.created_at) THEN RAISE EXCEPTION 'Knowledge audience and identity are immutable' USING ERRCODE='23514';END IF;
 IF (NEW.owner_id,NEW.kind,NEW.fresh_until,NEW.superseded_by,NEW.state) IS DISTINCT FROM (OLD.owner_id,OLD.kind,OLD.fresh_until,OLD.superseded_by,OLD.state) THEN
 NEW.review_epoch:=OLD.review_epoch+1;IF NEW.review_state='approved' THEN NEW.review_state:='draft';END IF;
 END IF;RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.protect_knowledge_page()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Knowledge edits must preserve identity and audience and advance one version' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.protect_knowledge_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' AND current_setting('ao.knowledge_purge',true)='yes' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.knowledge_provenance'::regclass) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Provenance events are immutable' USING ERRCODE='23514';END $function$;
CREATE OR REPLACE FUNCTION public.protect_knowledge_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' AND current_setting('ao.knowledge_purge',true)='yes' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.knowledge_versions'::regclass) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Knowledge revisions are immutable' USING ERRCODE='23514';END $function$;
CREATE OR REPLACE FUNCTION public.protect_memory_consent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='memory_release_requests' THEN
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'pending' THEN RAISE EXCEPTION 'Release request is immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['decision','auth_version','decided_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','auth_version','decided_at']) OR OLD.decision IN ('rejected','withdrawn') OR (OLD.decision='approved' AND NEW.decision<>'withdrawn') THEN RAISE EXCEPTION 'Source consent is immutable; an approval may only be withdrawn' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.protect_memory_release()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Release evidence is immutable; only revocation is allowed' USING ERRCODE='23514';END IF;RETURN NEW;END $function$;
CREATE OR REPLACE FUNCTION public.protect_task_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 RAISE EXCEPTION 'Task transition history is immutable' USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.protect_tool_action()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF (NEW.id,NEW.workspace_id,NEW.invocation_id,NEW.idempotency_key,NEW.capability_hash,NEW.capability_expires_at,NEW.encrypted_capability) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.invocation_id,OLD.idempotency_key,OLD.capability_hash,OLD.capability_expires_at,OLD.encrypted_capability)
 OR OLD.state IN ('succeeded','failed') OR OLD.state='outcome_unknown' AND NEW.state='dispatched' THEN
 RAISE EXCEPTION 'Action identity and terminal outcomes are immutable; uncertain actions cannot be replayed' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW; END $function$;
CREATE OR REPLACE FUNCTION public.queue_retrieval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE item jsonb; k text; target uuid; BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN item:=to_jsonb(OLD); ELSE item:=to_jsonb(NEW);END IF;
 k:=TG_ARGV[0]; target:=(CASE WHEN TG_TABLE_NAME='knowledge_metadata' THEN item->>'page_id' WHEN TG_TABLE_NAME='file_extractions' THEN item->>'file_id' ELSE item->>'id' END)::uuid;
 INSERT INTO public.retrieval_jobs(workspace_id,kind,source_id) VALUES((item->>'workspace_id')::uuid,k,target)
 ON CONFLICT(workspace_id,kind,source_id) DO UPDATE SET generation=public.retrieval_jobs.generation+1,state='pending',lease=NULL,lease_until=NULL,attempts=0,available_at=now(),updated_at=now();
 RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public.record_knowledge_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$ DECLARE item record; BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD;END IF;
 INSERT INTO knowledge_provenance(workspace_id,page_id,page_version,source_page_id,source_message_id,source_version,operation)
 SELECT item.workspace_id,item.page_id,p.version+CASE WHEN TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.version AND v.created_at>=transaction_timestamp()) THEN 1 ELSE 0 END,item.source_page_id,item.source_message_id,item.source_version,CASE WHEN TG_OP='INSERT' THEN 'linked' ELSE 'removed' END FROM knowledge_pages p WHERE p.workspace_id=item.workspace_id AND p.id=item.page_id;
 UPDATE knowledge_metadata SET review_state=CASE WHEN review_state='approved' THEN 'draft' ELSE review_state END,review_epoch=review_epoch+1,version=version+1 WHERE workspace_id=item.workspace_id AND page_id=item.page_id;
 IF TG_OP='INSERT' THEN RETURN NEW; ELSE RETURN OLD;END IF;
END $function$;
CREATE OR REPLACE FUNCTION public.record_tool_action()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 INSERT INTO tool_action_events(workspace_id,action_id,state,receipt) VALUES(NEW.workspace_id,NEW.id,NEW.state,NEW.receipt); RETURN NEW; END $function$;
CREATE OR REPLACE FUNCTION public.require_knowledge_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE target uuid;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
  IF TG_TABLE_NAME='knowledge_versions' THEN target=NEW.page_id; ELSE target=NEW.id; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM knowledge_pages p JOIN knowledge_versions v ON v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.version
    WHERE p.workspace_id=NEW.workspace_id AND p.id=target AND p.title=v.title AND p.body=v.body
      AND p.version=(SELECT max(h.version) FROM knowledge_versions h WHERE h.workspace_id=p.workspace_id AND h.page_id=p.id)
  ) THEN
    RAISE EXCEPTION 'A knowledge page requires a matching current revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.require_message_content()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE target uuid; tenant uuid;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='messages' THEN
  target=NEW.id; tenant=NEW.workspace_id;
 ELSE
  target=OLD.message_id; tenant=OLD.workspace_id;
 END IF;
 IF EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=tenant AND m.id=target AND m.deleted_at IS NULL AND m.body='' AND NOT EXISTS(SELECT 1 FROM message_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id)) THEN
  RAISE EXCEPTION 'A message requires text or an attachment' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END
$function$;
CREATE OR REPLACE FUNCTION public.revoke_agent_connections()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.key_hash IS DISTINCT FROM OLD.key_hash OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.status='archived' THEN
  UPDATE public.agent_credentials SET revoked_at=now() WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.id AND revoked_at IS NULL;
 END IF;
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.status='archived' THEN
  UPDATE public.agent_webhooks SET enabled=false,version=version+1 WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.id;
 END IF;
 RETURN NEW;
 END
$function$;
CREATE OR REPLACE FUNCTION public.revoke_native_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 UPDATE public.connection_native_hooks SET enabled=false,encrypted_secret='',version=version+1 WHERE workspace_id=NEW.workspace_id AND connection_id=NEW.id;
 RETURN NULL;END $function$;
CREATE OR REPLACE FUNCTION public.scrub_imported_tombstone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
 UPDATE public.migration_records r SET payload=jsonb_set(jsonb_set(jsonb_set(payload,'{body}','""'::jsonb),'{files}','[]'::jsonb),'{reactions}','[]'::jsonb)
 FROM public.migration_origins o WHERE o.workspace_id=NEW.workspace_id AND o.message_id=NEW.id AND r.workspace_id=o.workspace_id AND r.source_id=o.source_id AND r.external_channel_id=o.external_channel_id AND r.external_id=o.external_id;
 END IF;
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.set_message_creation_hash()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 NEW.creation_body_hash=encode(sha256(convert_to(NEW.body,'UTF8')),'hex');
 RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.stamp_task_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 NEW.assignment_version=OLD.assignment_version+CASE WHEN NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN 1 ELSE 0 END;
 RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.stamp_task_due_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 NEW.due_version := OLD.due_version + CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 1 ELSE 0 END;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.sync_call_transcript()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE target uuid; tenant uuid; meeting public.calls; content text;
BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' THEN target:=OLD.call_id;tenant:=OLD.workspace_id; ELSE target:=NEW.call_id;tenant:=NEW.workspace_id; END IF;
 SELECT * INTO meeting FROM public.calls WHERE workspace_id=tenant AND id=target FOR UPDATE;
 IF meeting.mode<>'retained_recording' OR meeting.expires_at<=now() THEN DELETE FROM public.retained_transcripts WHERE workspace_id=tenant AND call_id=target; RETURN NULL; END IF;
 SELECT string_agg(m.name || ': ' || s.text,E'\n' ORDER BY s.start_ms,s.id) INTO content FROM public.call_segments s JOIN public.memberships m ON m.workspace_id=s.workspace_id AND m.id=s.speaker_id WHERE s.workspace_id=tenant AND s.call_id=target;
 IF content IS NULL THEN DELETE FROM public.retained_transcripts WHERE workspace_id=tenant AND call_id=target; RETURN NULL; END IF;
 IF length(content)>200000 THEN RAISE EXCEPTION 'Call transcript limit exceeded' USING ERRCODE='22001'; END IF;
 INSERT INTO public.retained_transcripts(id,workspace_id,conversation_id,owner_id,client_id,call_id,title,body,language,consent_reference,retained_until,created_at)
 VALUES(target,tenant,meeting.conversation_id,meeting.owner_id,target,target,'Call transcript · ' || to_char(meeting.created_at,'YYYY-MM-DD'),content,'und','call-consent-ledger:'||target::text,meeting.expires_at,meeting.created_at)
 ON CONFLICT(workspace_id,call_id) WHERE call_id IS NOT NULL DO UPDATE SET body=EXCLUDED.body,version=public.retained_transcripts.version+1;
 RETURN NULL;
END
$function$;
CREATE OR REPLACE FUNCTION public.trace_run_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.execution_policies(workspace_id,needs_work) VALUES(NEW.workspace_id,true) ON CONFLICT(workspace_id) DO UPDATE SET needs_work=true;
  INSERT INTO public.run_traces(workspace_id,run_id,kind,summary) VALUES(NEW.workspace_id,NEW.id,'status',NEW.status);
  IF NEW.status IN ('cancelled','failed') AND NOT NEW.dispatch_started THEN
   UPDATE public.execution_reservations SET state='released',actual_micros=0,settled_at=now() WHERE workspace_id=NEW.workspace_id AND run_id=NEW.id AND state='reserved';
  END IF;
  IF NEW.status IN ('succeeded','failed','cancelled') THEN
   UPDATE public.agent_inbox SET state=CASE WHEN NEW.status='succeeded' THEN 'completed' ELSE 'dead' END,completed_at=CASE WHEN NEW.status='succeeded' THEN now() ELSE NULL END,summary='Hosted run '||NEW.status WHERE workspace_id=NEW.workspace_id AND run_id=NEW.id AND state='accepted';
  END IF;
 END IF;
 RETURN NEW;
 END
$function$;
CREATE OR REPLACE FUNCTION public.trace_tool_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.run_traces(workspace_id,run_id,kind,summary,resource_id) VALUES(NEW.workspace_id,NEW.run_id,'tool',NEW.tool_name||': '||NEW.status,NEW.id);
 END IF;
 RETURN NEW;
 END
$function$;
CREATE OR REPLACE FUNCTION public.validate_knowledge_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE audience uuid; source_audience uuid; live_version integer; BEGIN
 IF public.organization_erasure_authorized(coalesce((to_jsonb(OLD)->>'workspace_id')::uuid,(to_jsonb(NEW)->>'workspace_id')::uuid)) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 SELECT conversation_id INTO audience FROM knowledge_pages WHERE workspace_id=NEW.workspace_id AND id=NEW.page_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge target unavailable' USING ERRCODE='23514';END IF;
 IF NEW.source_page_id IS NOT NULL THEN
  SELECT p.conversation_id,p.version INTO source_audience,live_version FROM knowledge_pages p JOIN knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.source_page_id AND m.state='active' AND NOT m.blocked;
 ELSE
  SELECT conversation_id,version INTO source_audience,live_version FROM messages WHERE workspace_id=NEW.workspace_id AND id=NEW.source_message_id AND deleted_at IS NULL;
 END IF;
 IF TG_OP='INSERT' OR (NEW.source_page_id,NEW.source_message_id,NEW.source_version) IS DISTINCT FROM (OLD.source_page_id,OLD.source_message_id,OLD.source_version) THEN
  IF live_version IS NULL OR live_version<>NEW.source_version OR audience IS DISTINCT FROM source_audience THEN RAISE EXCEPTION 'Use a current knowledge source in the same audience' USING ERRCODE='23514';END IF;
  IF NEW.source_page_id IS NOT NULL AND EXISTS(WITH RECURSIVE parents(id) AS (SELECT NEW.source_page_id UNION SELECT s.source_page_id FROM knowledge_sources s JOIN parents p ON s.page_id=p.id WHERE s.workspace_id=NEW.workspace_id AND s.source_page_id IS NOT NULL) SELECT 1 FROM parents WHERE id=NEW.page_id) THEN RAISE EXCEPTION 'Knowledge source cycle' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;END $function$;
CREATE FUNCTION purge_organization_database(target uuid,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
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
CREATE FUNCTION finish_organization_erasure(target uuid,fence uuid,failed boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE job public.organization_erasures;next_state text;BEGIN
 IF current_setting('role',true)<>'ao_erasure' THEN RAISE EXCEPTION 'Erasure authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM public.organization_erasures WHERE id=target AND lease=fence AND lease_until>now() FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Erasure lease expired' USING ERRCODE='AOG03';END IF;
 next_state:=job.state;
 IF failed THEN next_state:=CASE WHEN job.failures>=7 THEN 'dead' ELSE job.state END;
 ELSIF job.database_deleted_at IS NOT NULL AND job.storage_deleted_at IS NOT NULL AND now()>=job.backup_not_before AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['backup','runtime','provider']) AS required(name) WHERE NOT EXISTS(SELECT 1 FROM public.organization_erasure_receipts r WHERE r.job_id=target AND r.processor=required.name AND r.completed_at>=job.created_at AND (r.processor<>'backup' OR r.completed_at>=job.backup_not_before))) THEN next_state:='completed';END IF;
 UPDATE public.organization_erasures SET state=next_state,lease=NULL,lease_until=NULL,failures=CASE WHEN failed THEN failures+1 ELSE 0 END,error_code=CASE WHEN failed THEN 'ERASURE_COMPONENT_FAILED' END,available_at=now()+CASE WHEN NOT failed AND next_state='purging' THEN interval '5 seconds' ELSE interval '5 minutes' END,completed_at=CASE WHEN next_state='completed' THEN now() END,manifest=CASE WHEN next_state='completed' THEN '[]'::jsonb ELSE manifest END,reason=CASE WHEN next_state='completed' THEN '[erased]' ELSE reason END WHERE id=target;
 IF next_state IS DISTINCT FROM job.state THEN INSERT INTO public.organization_audit(id,organization_id,actor_id,action,resource_id) VALUES(gen_random_uuid(),job.organization_id,NULL,CASE WHEN next_state='completed' THEN 'organization.erasure_completed' ELSE 'organization.erasure_state_changed' END,target::text);END IF;
 RETURN next_state;
END $body$;
REVOKE ALL ON FUNCTION claim_organization_erasure(),prepare_organization_erasure(uuid,uuid),purge_organization_database(uuid,uuid),finish_organization_erasure(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_organization_erasure(),prepare_organization_erasure(uuid,uuid),purge_organization_database(uuid,uuid),finish_organization_erasure(uuid,uuid,boolean) TO ao_erasure;

CREATE FUNCTION acknowledge_organization_storage(target uuid,fence uuid,item_index integer DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE job public.organization_erasures;BEGIN
 IF current_setting('role',true)<>'ao_erasure' THEN RAISE EXCEPTION 'Erasure authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO job FROM public.organization_erasures WHERE id=target AND lease=fence AND lease_until>now() AND state='purging' FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Erasure lease expired' USING ERRCODE='AOG03';END IF;
 IF item_index IS NOT NULL AND (item_index<0 OR item_index>=jsonb_array_length(job.manifest)) THEN RAISE EXCEPTION 'Invalid erasure item';END IF;
 IF item_index IS NOT NULL THEN UPDATE public.organization_erasures SET manifest=jsonb_set(manifest,ARRAY[item_index::text,'done'],'true'),lease_until=now()+interval '5 minutes' WHERE id=target;
 ELSE UPDATE public.organization_erasures SET storage_deleted_at=now(),lease_until=now()+interval '5 minutes' WHERE id=target;END IF;
END $body$;
REVOKE ALL ON FUNCTION acknowledge_organization_storage(uuid,uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION acknowledge_organization_storage(uuid,uuid,integer) TO ao_erasure;
CREATE FUNCTION renew_organization_erasure(target uuid,fence uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$ WITH renewed AS(UPDATE public.organization_erasures SET lease_until=now()+interval '5 minutes' WHERE current_setting('role',true)='ao_erasure' AND id=target AND lease=fence AND lease_until>now() AND state='purging' RETURNING id) SELECT EXISTS(SELECT 1 FROM renewed) $body$;
REVOKE ALL ON FUNCTION renew_organization_erasure(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION renew_organization_erasure(uuid,uuid) TO ao_erasure;
