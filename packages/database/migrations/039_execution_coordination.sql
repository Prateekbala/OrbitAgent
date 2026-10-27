CREATE TABLE execution_policies (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), version integer NOT NULL DEFAULT 1,
 budget_micros bigint NOT NULL DEFAULT 50000000 CHECK(budget_micros>=0),
 max_open_runs integer NOT NULL DEFAULT 20 CHECK(max_open_runs BETWEEN 1 AND 500),
 max_concurrent_runs integer NOT NULL DEFAULT 4 CHECK(max_concurrent_runs BETWEEN 1 AND 32),
 max_agent_concurrent integer NOT NULL DEFAULT 1 CHECK(max_agent_concurrent BETWEEN 1 AND 8),
 max_requester_concurrent integer NOT NULL DEFAULT 2 CHECK(max_requester_concurrent BETWEEN 1 AND 16),
 max_delegation_depth integer NOT NULL DEFAULT 3 CHECK(max_delegation_depth BETWEEN 0 AND 5),
 max_delegation_children integer NOT NULL DEFAULT 5 CHECK(max_delegation_children BETWEEN 0 AND 20),
 last_dispatched_at timestamptz,
 needs_work boolean NOT NULL DEFAULT false
);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('message','mention','reply','reaction','task_assigned','task_comment','task_reminder','task_activity','workflow_attention','approval_request','group_added','agent_attention'));
INSERT INTO execution_policies(workspace_id) SELECT id FROM workspaces;
UPDATE execution_policies p SET needs_work=EXISTS(SELECT 1 FROM agent_runs r WHERE r.workspace_id=p.workspace_id AND r.status IN ('queued','running','awaiting_approval','outcome_unknown')) OR EXISTS(SELECT 1 FROM agent_inbox i JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id WHERE i.workspace_id=p.workspace_id AND i.state='pending' AND a.runtime='managed');
ALTER TABLE agent_runs ADD COLUMN agent_revision integer;
ALTER TABLE agent_runs ADD COLUMN configuration jsonb;
ALTER TABLE agent_runs ADD COLUMN deadline_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN started_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN dispatch_order bigint;
ALTER TABLE agent_runs ADD COLUMN resumed_from uuid;
ALTER TABLE agent_runs ADD COLUMN parent_run_id uuid;
ALTER TABLE agent_runs ADD COLUMN root_run_id uuid;
ALTER TABLE agent_runs ADD COLUMN delegation_depth integer NOT NULL DEFAULT 0 CHECK(delegation_depth BETWEEN 0 AND 5);
ALTER TABLE agent_runs ADD COLUMN owner_id uuid;
ALTER TABLE agent_runs ADD COLUMN verifier_id uuid;
ALTER TABLE agent_runs ADD COLUMN output_contract text;
ALTER TABLE agent_runs ADD COLUMN stop_condition text;
ALTER TABLE agent_runs ADD COLUMN delegation_deadline timestamptz;
ALTER TABLE agent_runs ADD COLUMN delegation_budget_micros bigint;
ALTER TABLE agent_runs ADD COLUMN delegation_hash text;
ALTER TABLE agent_runs ADD COLUMN verification_status text NOT NULL DEFAULT 'not_required' CHECK(verification_status IN ('not_required','pending','accepted','rejected','escalated'));
ALTER TABLE agent_runs ADD COLUMN verification_evidence text;
ALTER TABLE agent_runs ADD COLUMN verified_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN policy_version integer;
ALTER TABLE agent_runs ADD COLUMN requester_policy_version integer;
ALTER TABLE agent_runs ADD CONSTRAINT run_revision_fk FOREIGN KEY(workspace_id,agent_id,agent_revision) REFERENCES agent_revisions(workspace_id,agent_id,revision);
ALTER TABLE agent_runs ADD CONSTRAINT run_parent_fk FOREIGN KEY(workspace_id,parent_run_id) REFERENCES agent_runs(workspace_id,id);
ALTER TABLE agent_runs ADD CONSTRAINT run_root_fk FOREIGN KEY(workspace_id,root_run_id) REFERENCES agent_runs(workspace_id,id);
ALTER TABLE agent_runs ADD CONSTRAINT run_resume_fk FOREIGN KEY(workspace_id,resumed_from) REFERENCES agent_runs(workspace_id,id);
ALTER TABLE agent_runs ADD CONSTRAINT run_owner_fk FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id);
ALTER TABLE agent_runs ADD CONSTRAINT run_verifier_fk FOREIGN KEY(workspace_id,verifier_id) REFERENCES memberships(workspace_id,id);
ALTER TABLE agent_inbox ADD COLUMN run_id uuid;
ALTER TABLE agent_inbox ADD CONSTRAINT inbox_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id);
CREATE TABLE execution_reservations (
 workspace_id uuid NOT NULL,run_id uuid NOT NULL,amount_micros bigint NOT NULL CHECK(amount_micros>0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),
 actual_micros bigint CHECK(actual_micros>=0), input_tokens bigint, output_tokens bigint,
 receipt text, settled_by uuid, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 CHECK((state='reserved' AND actual_micros IS NULL AND settled_at IS NULL) OR (state='released' AND actual_micros=0 AND settled_at IS NOT NULL) OR (state='settled' AND actual_micros IS NOT NULL AND settled_at IS NOT NULL)),
 PRIMARY KEY(workspace_id,run_id), FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,settled_by) REFERENCES memberships(workspace_id,id)
);
UPDATE agent_runs r SET agent_revision=a.revision,configuration=jsonb_set(v.configuration,'{instructions}',to_jsonb(r.instructions)),policy_version=1,requester_policy_version=(SELECT o.version FROM workspaces w JOIN organizations o ON o.id=w.organization_id WHERE w.id=r.workspace_id)
 FROM agents a JOIN agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision
 WHERE a.workspace_id=r.workspace_id AND a.id=r.agent_id AND r.status IN ('queued','running','awaiting_approval','outcome_unknown');
INSERT INTO execution_reservations(workspace_id,run_id,amount_micros,state,actual_micros,receipt,settled_at)
 SELECT workspace_id,id,500000,CASE WHEN status='awaiting_approval' THEN 'settled' ELSE 'reserved' END,CASE WHEN status='awaiting_approval' THEN 500000 ELSE NULL END,CASE WHEN status='awaiting_approval' THEN 'legacy_conservative_reservation' ELSE NULL END,CASE WHEN status='awaiting_approval' THEN now() ELSE NULL END FROM agent_runs WHERE status IN ('queued','running','awaiting_approval','outcome_unknown');
CREATE TABLE run_checkpoints (
 workspace_id uuid NOT NULL,run_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0),
 kind text NOT NULL CHECK(kind IN ('prepared','dispatched','settled','recovered','progress')),
 summary text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,ordinal), FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id)
);
CREATE TABLE run_traces (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL,run_id uuid NOT NULL,
 kind text NOT NULL, summary text NOT NULL CHECK(length(summary)<=2000), resource_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id)
);
CREATE INDEX run_trace_page ON run_traces(workspace_id,run_id,id);
CREATE FUNCTION immutable_run_record() RETURNS trigger LANGUAGE plpgsql AS $body$
 BEGIN RAISE EXCEPTION 'Run checkpoints and traces are append-only' USING ERRCODE='23514'; END
$body$;
CREATE TRIGGER immutable_run_checkpoint BEFORE UPDATE OR DELETE ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION immutable_run_record();
CREATE TRIGGER immutable_run_trace BEFORE UPDATE OR DELETE ON run_traces FOR EACH ROW EXECUTE FUNCTION immutable_run_record();
CREATE FUNCTION guard_execution_reservation() RETURNS trigger LANGUAGE plpgsql AS $body$
 BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.run_id<>OLD.run_id OR NEW.amount_micros<>OLD.amount_micros OR NEW.created_at<>OLD.created_at OR OLD.state<>'reserved' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Spending reservations have immutable identity and terminal settlements' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
 END
$body$;
CREATE TRIGGER guard_execution_reservation BEFORE UPDATE ON execution_reservations FOR EACH ROW EXECUTE FUNCTION guard_execution_reservation();
CREATE FUNCTION execution_totals(tenant uuid) RETURNS TABLE(reserved_micros bigint,spent_micros bigint,open_runs bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT coalesce(sum(r.amount_micros) FILTER(WHERE r.state='reserved'),0)::bigint,
 coalesce(sum(r.actual_micros) FILTER(WHERE r.state='settled'),0)::bigint,
 (SELECT count(*) FROM public.agent_runs a WHERE a.workspace_id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND a.status IN ('queued','running','awaiting_approval','outcome_unknown'))
 FROM public.execution_reservations r WHERE r.workspace_id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
REVOKE ALL ON FUNCTION execution_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execution_totals(uuid) TO ao_runtime,ao_worker;
ALTER TABLE tool_invocations DROP CONSTRAINT tool_invocations_tool_name_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_tool_name_check CHECK(tool_name IN ('create_task','save_knowledge','delegate_agent'));
CREATE FUNCTION trace_run_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 BEGIN
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
$body$;
CREATE TRIGGER trace_run_state AFTER INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION trace_run_state();
CREATE FUNCTION trace_tool_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.run_traces(workspace_id,run_id,kind,summary,resource_id) VALUES(NEW.workspace_id,NEW.run_id,'tool',NEW.tool_name||': '||NEW.status,NEW.id);
 END IF;
 RETURN NEW;
 END
$body$;
CREATE TRIGGER trace_tool_state AFTER INSERT OR UPDATE ON tool_invocations FOR EACH ROW EXECUTE FUNCTION trace_tool_state();
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['execution_policies','execution_reservations','run_checkpoints','run_traces'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 IF name<>'execution_policies' THEN
 EXECUTE format('CREATE POLICY run_audience ON %I AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM agent_runs r WHERE r.workspace_id=%I.workspace_id AND r.id=run_id))',name,name);
 END IF;
 END LOOP;
END
$body$;
GRANT USAGE,SELECT ON SEQUENCE run_traces_id_seq TO ao_runtime,ao_worker;
GRANT SELECT(workspace_id,last_dispatched_at,needs_work) ON execution_policies TO ao_dispatcher;
CREATE POLICY execution_dispatch ON execution_policies FOR SELECT TO ao_dispatcher USING(true);
