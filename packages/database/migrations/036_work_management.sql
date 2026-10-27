ALTER TABLE tasks ADD COLUMN start_date date CHECK(start_date BETWEEN date '0001-01-01' AND date '9999-12-31');
ALTER TABLE tasks ADD COLUMN estimate numeric(12,2) CHECK(estimate BETWEEN 0 AND 100000);
ALTER TABLE tasks ADD CONSTRAINT task_planned_dates CHECK(start_date IS NULL OR due_date IS NULL OR start_date<=due_date);
CREATE TABLE task_participants (
 workspace_id uuid NOT NULL,task_id uuid NOT NULL,membership_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('watcher','collaborator')),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,task_id,membership_id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE task_artifacts (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,task_id uuid NOT NULL,created_by uuid NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('link','file','decision','test_result','document')),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),url text CHECK(url ~ '^https?://'),file_id uuid,details text NOT NULL CHECK(length(details)<=12000),outcome text NOT NULL CHECK(outcome IN ('proposed','passed','failed')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,task_id,id),UNIQUE(workspace_id,task_id,created_by,client_id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id)
);
CREATE TABLE task_criteria (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,task_id uuid NOT NULL,text text NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),required boolean NOT NULL DEFAULT true,accepted boolean NOT NULL DEFAULT false,evidence text NOT NULL DEFAULT '' CHECK(length(evidence)<=4000),reviewed_by uuid,artifact_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,task_id,id),CHECK(NOT accepted OR (length(evidence)>0 AND reviewed_by IS NOT NULL)),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,reviewed_by) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,task_id,artifact_id) REFERENCES task_artifacts(workspace_id,task_id,id)
);
CREATE TABLE task_criterion_reviews (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,task_id uuid NOT NULL,criterion_id uuid NOT NULL,reviewed_by uuid NOT NULL,accepted boolean NOT NULL,evidence text NOT NULL,artifact_id uuid,task_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,task_id,criterion_id) REFERENCES task_criteria(workspace_id,task_id,id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,reviewed_by) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,task_id,artifact_id) REFERENCES task_artifacts(workspace_id,task_id,id)
);
CREATE TABLE task_sources (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,task_id uuid NOT NULL,message_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('discussion','decision')),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,task_id,message_id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE task_runs (
 workspace_id uuid NOT NULL,task_id uuid NOT NULL,run_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,task_id,run_id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE FUNCTION guard_task_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='completed' AND EXISTS(SELECT 1 FROM task_criteria WHERE workspace_id=NEW.workspace_id AND task_id=NEW.id AND required AND NOT accepted) THEN RAISE EXCEPTION 'Required acceptance criteria are unverified' USING ERRCODE='AOT05'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_acceptance BEFORE UPDATE OF state ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_acceptance();

CREATE TABLE work_templates (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,conversation_id uuid,name text NOT NULL CHECK(length(name) BETWEEN 2 AND 160),kind text NOT NULL CHECK(kind IN ('task','workflow')),created_by uuid NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL,version integer NOT NULL DEFAULT 1,latest_revision integer NOT NULL DEFAULT 1,published_revision integer,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,created_by,client_id),FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE work_template_versions (
 workspace_id uuid NOT NULL,template_id uuid NOT NULL,revision integer NOT NULL,definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,template_id,revision),FOREIGN KEY(workspace_id,template_id) REFERENCES work_templates(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE work_templates ADD CONSTRAINT published_template_version FOREIGN KEY(workspace_id,id,published_revision) REFERENCES work_template_versions(workspace_id,template_id,revision) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE work_templates ADD CONSTRAINT latest_template_version FOREIGN KEY(workspace_id,id,latest_revision) REFERENCES work_template_versions(workspace_id,template_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE workflow_events (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,task_id uuid NOT NULL,conversation_id uuid,event_type text NOT NULL,task_version integer NOT NULL,state text NOT NULL,origin_run_id uuid,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),processed_at timestamptz,
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX workflow_event_pending ON workflow_events(workspace_id,created_at,id) WHERE processed_at IS NULL;
CREATE TABLE workflow_triggers (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,template_id uuid NOT NULL,template_revision integer NOT NULL,event_type text NOT NULL,state text,project_id uuid,enabled boolean NOT NULL DEFAULT true,created_by uuid NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,created_by,client_id),FOREIGN KEY(workspace_id,template_id,template_revision) REFERENCES work_template_versions(workspace_id,template_id,revision),FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE workflow_runs (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,template_id uuid NOT NULL,template_revision integer NOT NULL,conversation_id uuid,source_task_id uuid,project_id uuid,created_by uuid NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL,auth_version integer NOT NULL,policy_version integer NOT NULL,trigger_id uuid,event_id uuid,replay_of uuid,status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','succeeded','failed','cancelled')),next_step integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,error_code text,escalated_at timestamptz,deadline_at timestamptz NOT NULL,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,created_by,client_id),UNIQUE(workspace_id,trigger_id,event_id),FOREIGN KEY(workspace_id,template_id,template_revision) REFERENCES work_template_versions(workspace_id,template_id,revision),FOREIGN KEY(workspace_id,source_task_id) REFERENCES tasks(workspace_id,id),FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,trigger_id) REFERENCES workflow_triggers(workspace_id,id),FOREIGN KEY(workspace_id,event_id) REFERENCES workflow_events(workspace_id,id),FOREIGN KEY(workspace_id,replay_of) REFERENCES workflow_runs(workspace_id,id)
);
CREATE INDEX workflow_ready ON workflow_runs(workspace_id,available_at,id) WHERE status IN ('queued','running','waiting');
CREATE TABLE workflow_steps (
 workspace_id uuid NOT NULL,run_id uuid NOT NULL,step_key text NOT NULL,status text NOT NULL CHECK(status IN ('running','waiting','succeeded','failed')),output jsonb NOT NULL DEFAULT '{}',attempts integer NOT NULL DEFAULT 0,error_code text,decision_by uuid,decision_evidence text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,run_id,step_key),FOREIGN KEY(workspace_id,run_id) REFERENCES workflow_runs(workspace_id,id),FOREIGN KEY(workspace_id,decision_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE workflow_notices (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,run_id uuid NOT NULL,recipient_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('approval','escalation')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),acknowledged_at timestamptz,
 UNIQUE(workspace_id,run_id,recipient_id,kind),FOREIGN KEY(workspace_id,run_id) REFERENCES workflow_runs(workspace_id,id),FOREIGN KEY(workspace_id,recipient_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE portfolios (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,conversation_id uuid,name text NOT NULL CHECK(length(name) BETWEEN 2 AND 160),created_by uuid NOT NULL,version integer NOT NULL DEFAULT 1,client_id uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,created_by,client_id),FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE portfolio_projects (
 workspace_id uuid NOT NULL,portfolio_id uuid NOT NULL,project_id uuid NOT NULL,PRIMARY KEY(workspace_id,portfolio_id,project_id),FOREIGN KEY(workspace_id,portfolio_id) REFERENCES portfolios(workspace_id,id),FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE TABLE business_calendars (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,name text NOT NULL,time_zone text NOT NULL,weekdays integer[] NOT NULL CHECK(cardinality(weekdays) BETWEEN 1 AND 7),holidays text[] NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE task_recurrences DROP CONSTRAINT task_recurrences_frequency_check;
ALTER TABLE task_recurrences ADD CONSTRAINT task_recurrences_frequency_check CHECK(frequency IN ('daily','weekly','monthly','business_daily'));
ALTER TABLE task_recurrences ADD COLUMN business_calendar jsonb;

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['task_participants','task_artifacts','task_criteria','task_criterion_reviews','task_sources','task_runs','work_templates','work_template_versions','workflow_events','workflow_triggers','workflow_runs','workflow_steps','workflow_notices','portfolios','portfolio_projects','business_calendars'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['task_participants','task_artifacts','task_criteria','task_criterion_reviews','task_sources','task_runs','workflow_events'] LOOP
  EXECUTE format('CREATE POLICY task_history ON %I AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=%I.workspace_id AND t.id=task_id))',name,name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['work_templates','workflow_runs','portfolios'] LOOP
  EXECUTE format('CREATE POLICY resource_history ON %I AS RESTRICTIVE FOR SELECT TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting(''ao.membership_id'',true),'''')::uuid))',name);
 END LOOP;
END $$;
CREATE POLICY source_history ON task_sources AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=task_sources.workspace_id AND m.id=message_id));
CREATE POLICY run_history ON task_runs AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM agent_runs r WHERE r.workspace_id=task_runs.workspace_id AND r.id=run_id));
CREATE POLICY template_history ON work_template_versions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM work_templates t WHERE t.workspace_id=work_template_versions.workspace_id AND t.id=template_id));
CREATE POLICY template_history ON workflow_triggers AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM work_templates t WHERE t.workspace_id=workflow_triggers.workspace_id AND t.id=template_id));
CREATE POLICY run_history ON workflow_steps AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM workflow_runs r WHERE r.workspace_id=workflow_steps.workspace_id AND r.id=run_id));
CREATE POLICY notice_owner ON workflow_notices AS RESTRICTIVE TO ao_runtime USING(recipient_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND EXISTS(SELECT 1 FROM workflow_runs r WHERE r.workspace_id=workflow_notices.workspace_id AND r.id=run_id));
CREATE POLICY portfolio_history ON portfolio_projects AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM portfolios p WHERE p.workspace_id=portfolio_projects.workspace_id AND p.id=portfolio_id) AND EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=portfolio_projects.workspace_id AND p.id=project_id));
REVOKE UPDATE,DELETE ON work_template_versions,task_artifacts,task_criterion_reviews,task_runs FROM ao_runtime,ao_worker;
CREATE INDEX task_participant_member ON task_participants(workspace_id,membership_id,task_id);
CREATE INDEX task_criteria_task ON task_criteria(workspace_id,task_id,id);
CREATE INDEX task_artifacts_task ON task_artifacts(workspace_id,task_id,id);
CREATE INDEX task_sources_task ON task_sources(workspace_id,task_id,id);
CREATE INDEX task_run_history ON task_runs(workspace_id,task_id,created_at,run_id);
CREATE INDEX work_template_scope ON work_templates(workspace_id,conversation_id,id);
CREATE INDEX workflow_run_history ON workflow_runs(workspace_id,template_id,id);
CREATE INDEX workflow_notice_owner ON workflow_notices(workspace_id,recipient_id,id);
CREATE INDEX portfolio_scope ON portfolios(workspace_id,conversation_id,id);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('message','mention','reply','reaction','task_assigned','task_comment','task_reminder','task_activity','workflow_attention','approval_request','group_added'));

CREATE FUNCTION conversation_has_history(tenant uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND (
 EXISTS(SELECT 1 FROM public.conversations c WHERE c.workspace_id=tenant AND c.id=conversation AND c.next_sequence>0)
 OR EXISTS(SELECT 1 FROM public.tasks t WHERE t.workspace_id=tenant AND t.conversation_id=conversation)
 OR EXISTS(SELECT 1 FROM public.projects p WHERE p.workspace_id=tenant AND p.conversation_id=conversation)
 OR EXISTS(SELECT 1 FROM public.knowledge_pages p WHERE p.workspace_id=tenant AND p.conversation_id=conversation)
 OR EXISTS(SELECT 1 FROM public.agent_runs r WHERE r.workspace_id=tenant AND r.conversation_id=conversation))
$$;
REVOKE ALL ON FUNCTION conversation_has_history(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION conversation_has_history(uuid,uuid) TO ao_runtime,ao_worker;
CREATE OR REPLACE FUNCTION conversation_membership_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE floor integer; channel record;
BEGIN
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
$body$;
