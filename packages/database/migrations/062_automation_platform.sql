CREATE TABLE automations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces,
 owner_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 2 AND 120),
 conversation_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), status text NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','archived')),
 owner_auth_version integer NOT NULL, policy_version integer NOT NULL,
 client_id uuid NOT NULL, request_hash text NOT NULL,
 next_at timestamptz, event_cursor bigint NOT NULL DEFAULT 0,
 last_publication_at timestamptz, last_result_hash text,
 transfer_to uuid, transfer_version integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,owner_id,client_id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,transfer_to) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE automation_versions (
 workspace_id uuid NOT NULL, automation_id uuid NOT NULL, revision integer NOT NULL,
 definition jsonb NOT NULL, authority_snapshot jsonb NOT NULL DEFAULT '{}', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,automation_id,revision),
 FOREIGN KEY(workspace_id,automation_id) REFERENCES automations(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE automation_occurrences (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, automation_id uuid NOT NULL, revision integer NOT NULL,
 occurrence_key text NOT NULL CHECK(length(occurrence_key)<=200), scheduled_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','skipped','cancelled','outcome_unknown')),
 reason text, event_id bigint, event_type text, resource_id uuid, agent_run_id uuid, workflow_run_id uuid,
 replay_of uuid, replay_reason text, created_by uuid NOT NULL,
 started_at timestamptz, finished_at timestamptz, deadline_at timestamptz,
 escalated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,automation_id,occurrence_key),
 FOREIGN KEY(workspace_id,automation_id,revision) REFERENCES automation_versions(workspace_id,automation_id,revision),
 FOREIGN KEY(workspace_id,agent_run_id) REFERENCES agent_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,workflow_run_id) REFERENCES workflow_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,replay_of) REFERENCES automation_occurrences(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX automation_due ON automations(workspace_id,next_at) WHERE status='active';
CREATE INDEX automation_active_occurrences ON automation_occurrences(workspace_id,automation_id,status,scheduled_at);
ALTER TABLE agent_runs ADD COLUMN automation_occurrence_id uuid;
ALTER TABLE agent_runs ADD FOREIGN KEY(workspace_id,automation_occurrence_id) REFERENCES automation_occurrences(workspace_id,id);
ALTER TABLE workflow_runs ADD COLUMN automation_occurrence_id uuid;
ALTER TABLE workflow_runs ADD FOREIGN KEY(workspace_id,automation_occurrence_id) REFERENCES automation_occurrences(workspace_id,id);
ALTER TABLE outbox_events ADD COLUMN actor_id uuid;
ALTER TABLE outbox_events ADD COLUMN origin_automation_id uuid;
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['automations','automation_versions','automation_occurrences'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO ao_runtime,ao_worker',name);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END
$body$;
CREATE POLICY automation_audience ON automations AS RESTRICTIVE TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND (owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM memberships WHERE workspace_id=automations.workspace_id AND id=nullif(current_setting('ao.membership_id',true),'')::uuid AND role IN ('owner','admin')))) WITH CHECK(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY automation_audience ON automation_versions AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM automations a WHERE a.workspace_id=automation_versions.workspace_id AND a.id=automation_id)) WITH CHECK(EXISTS(SELECT 1 FROM automations a WHERE a.workspace_id=automation_versions.workspace_id AND a.id=automation_id));
CREATE POLICY automation_audience ON automation_occurrences AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM automations a WHERE a.workspace_id=automation_occurrences.workspace_id AND a.id=automation_id)) WITH CHECK(EXISTS(SELECT 1 FROM automations a WHERE a.workspace_id=automation_occurrences.workspace_id AND a.id=automation_id));
REVOKE UPDATE ON automation_versions FROM ao_runtime;
DROP POLICY automation_audience ON automations;
CREATE POLICY automation_audience ON automations AS RESTRICTIVE TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND (owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR transfer_to=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM memberships WHERE workspace_id=automations.workspace_id AND id=nullif(current_setting('ao.membership_id',true),'')::uuid AND role IN ('owner','admin')))) WITH CHECK(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE FUNCTION automation_occurrence_allowed(tenant uuid,occurrence uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT occurrence IS NULL OR (tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.automation_occurrences o JOIN public.automations a ON a.workspace_id=o.workspace_id AND a.id=o.automation_id
 WHERE o.workspace_id=tenant AND o.id=occurrence AND o.revision=a.revision AND a.status='active' AND o.status IN ('queued','running') AND o.created_by=a.owner_id AND (o.deadline_at IS NULL OR o.deadline_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM public.automation_versions v CROSS JOIN LATERAL jsonb_each_text(coalesce(v.authority_snapshot->'agentRevisions','{}'::jsonb)) pin WHERE v.workspace_id=o.workspace_id AND v.automation_id=o.automation_id AND v.revision=o.revision AND NOT EXISTS(SELECT 1 FROM public.agents agent WHERE agent.workspace_id=tenant AND agent.id=pin.key::uuid AND agent.revision=pin.value::integer AND agent.status='active'))))
$body$;
REVOKE ALL ON FUNCTION automation_occurrence_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION automation_occurrence_allowed(uuid,uuid) TO ao_runtime,ao_worker;

CREATE FUNCTION immutable_automation_version() RETURNS trigger LANGUAGE plpgsql AS $body$
 BEGIN RAISE EXCEPTION 'Automation revisions are immutable' USING ERRCODE='23514'; END
$body$;
CREATE TRIGGER immutable_automation_version BEFORE UPDATE OR DELETE ON automation_versions FOR EACH ROW EXECUTE FUNCTION immutable_automation_version();
ALTER TABLE agent_runs ADD COLUMN published_at timestamptz;
ALTER TABLE automations ADD COLUMN escalation_member_id uuid;
ALTER TABLE automations ADD FOREIGN KEY(workspace_id,escalation_member_id) REFERENCES memberships(workspace_id,id);
DROP POLICY automation_audience ON automations;
CREATE POLICY automation_audience ON automations AS RESTRICTIVE TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND (owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR transfer_to=nullif(current_setting('ao.membership_id',true),'')::uuid OR escalation_member_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM memberships WHERE workspace_id=automations.workspace_id AND id=nullif(current_setting('ao.membership_id',true),'')::uuid AND role IN ('owner','admin')))) WITH CHECK(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid));
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('message','mention','reply','reaction','task_assigned','task_comment','task_reminder','task_activity','workflow_attention','approval_request','group_added','agent_attention','automation_attention'));
