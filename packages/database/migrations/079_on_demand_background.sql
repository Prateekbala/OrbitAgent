CREATE TABLE background_schedules (
 worker text PRIMARY KEY,
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 published_generation bigint NOT NULL DEFAULT 0,
 published_at timestamptz,
 due_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz,
 failures integer NOT NULL DEFAULT 0,
 last_completed_at timestamptz, last_due timestamptz,
 idle_passes integer NOT NULL DEFAULT 0
);
ALTER TABLE background_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_schedules FORCE ROW LEVEL SECURITY;
GRANT SELECT,UPDATE ON background_schedules TO ao_dispatcher;
CREATE POLICY background_dispatcher ON background_schedules TO ao_dispatcher USING(true) WITH CHECK(true);
INSERT INTO background_schedules(worker) VALUES
 ('tools'),
 ('connections'),
 ('embeddings'),
 ('retrieval'),
 ('knowledge'),
 ('execution'),
 ('agent-delivery'),
 ('email'),
 ('calls'),
 ('notifications'),
 ('files'),
 ('billing'),
 ('file-governance'),
 ('activity'),
 ('identity'),
 ('messages'),
 ('scheduling'),
 ('developer-webhooks'),
 ('shared-retention'),
 ('migrations'),
 ('automations'),
 ('workflows'),
 ('calendar'),
 ('lifecycle');
CREATE FUNCTION request_background_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE target text;
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  FOREACH target IN ARRAY TG_ARGV LOOP
    IF coalesce(current_setting('ao.background_worker',true),'')=target THEN
      CONTINUE;
    END IF;
    UPDATE public.background_schedules
    SET due_at=clock_timestamp(),generation=generation+1,idle_passes=0
    WHERE worker=target AND due_at>clock_timestamp();
  END LOOP;
  RETURN NULL;
END $body$;
REVOKE ALL ON FUNCTION request_background_work() FROM PUBLIC;
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON email_jobs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('email');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','workflows','automations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON agent_inbox
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','agent-delivery');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON agent_wakeups
  FOR EACH ROW EXECUTE FUNCTION request_background_work('agent-delivery');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON agent_webhooks
  FOR EACH ROW EXECUTE FUNCTION request_background_work('agent-delivery');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON tool_invocations
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','tools');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON tool_actions
  FOR EACH ROW EXECUTE FUNCTION request_background_work('tools');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON execution_policies
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','agent-delivery');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON retrieval_jobs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('retrieval');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON retrieval_embedding_jobs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('embeddings');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON knowledge_schedules
  FOR EACH ROW EXECUTE FUNCTION request_background_work('knowledge');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON knowledge_metadata
  FOR EACH ROW EXECUTE FUNCTION request_background_work('knowledge');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION request_background_work('messages');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON task_recurrences
  FOR EACH ROW EXECUTE FUNCTION request_background_work('scheduling');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON task_reminders
  FOR EACH ROW EXECUTE FUNCTION request_background_work('scheduling');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION request_background_work('scheduling','calendar');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION request_background_work('notifications');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION request_background_work('notifications');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON notification_delivery_preferences
  FOR EACH ROW EXECUTE FUNCTION request_background_work('notifications');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON notification_devices
  FOR EACH ROW EXECUTE FUNCTION request_background_work('notifications');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON connection_events
  FOR EACH ROW EXECUTE FUNCTION request_background_work('connections');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON connection_deliveries
  FOR EACH ROW EXECUTE FUNCTION request_background_work('connections');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON connections
  FOR EACH ROW EXECUTE FUNCTION request_background_work('connections');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON developer_deliveries
  FOR EACH ROW EXECUTE FUNCTION request_background_work('developer-webhooks');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON developer_webhooks
  FOR EACH ROW EXECUTE FUNCTION request_background_work('developer-webhooks');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION request_background_work('developer-webhooks','automations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION request_background_work('workflows');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('workflows','automations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON automations
  FOR EACH ROW EXECUTE FUNCTION request_background_work('automations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON automation_occurrences
  FOR EACH ROW EXECUTE FUNCTION request_background_work('automations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON calendar_connections
  FOR EACH ROW EXECUTE FUNCTION request_background_work('calendar');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON calendar_exports
  FOR EACH ROW EXECUTE FUNCTION request_background_work('calendar');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON migration_records
  FOR EACH ROW EXECUTE FUNCTION request_background_work('migrations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON migration_sources
  FOR EACH ROW EXECUTE FUNCTION request_background_work('migrations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON migration_deliveries
  FOR EACH ROW EXECUTE FUNCTION request_background_work('migrations');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION request_background_work('billing');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON billing_accounts
  FOR EACH ROW EXECUTE FUNCTION request_background_work('billing');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION request_background_work('files','file-governance');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON file_versions
  FOR EACH ROW EXECUTE FUNCTION request_background_work('file-governance');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON file_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION request_background_work('file-governance');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON calls
  FOR EACH ROW EXECUTE FUNCTION request_background_work('calls');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON call_participants
  FOR EACH ROW EXECUTE FUNCTION request_background_work('calls');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON lifecycle_jobs
  FOR EACH ROW EXECUTE FUNCTION request_background_work('lifecycle');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION request_background_work('lifecycle');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','calls','notifications','scheduling');
CREATE TRIGGER background_wake AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION request_background_work('execution','calls');
CREATE FUNCTION background_next_at(target text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE due timestamptz;
BEGIN
  CASE target
    WHEN 'email' THEN
      SELECT min(CASE WHEN status='sending' THEN lease_expires_at ELSE available_at END) INTO due
      FROM public.email_jobs
      WHERE status IN ('queued','sending');
    WHEN 'execution' THEN
      SELECT min(at) INTO due
      FROM ( SELECT created_at at
      FROM public.agent_runs r
      WHERE status='queued'
      UNION ALL SELECT lease_expires_at
      FROM public.agent_runs
      WHERE status='running'
      UNION ALL SELECT i.expires_at
      FROM public.tool_invocations i
      JOIN public.agent_runs r ON r.id=i.run_id
      WHERE r.status='awaiting_approval'
      AND i.status='pending'
      UNION ALL SELECT i.created_at
      FROM public.tool_invocations i
      WHERE i.status='approved'
      UNION ALL SELECT i.created_at
      FROM public.agent_inbox i
      JOIN public.agents a ON a.id=i.agent_id
      WHERE i.state='pending'
      AND a.runtime='managed'
      AND a.status='active'
      AND i.expires_at>now()
      UNION ALL SELECT delegation_deadline
      FROM public.agent_runs
      WHERE parent_run_id IS NOT NULL
      AND (status IN ('queued','running','awaiting_approval') OR verification_status='pending') ) q;
    WHEN 'tools' THEN
      SELECT min(CASE WHEN state='dispatched' THEN updated_at+interval '45 seconds' WHEN state='outcome_unknown' THEN updated_at+interval '60 seconds' ELSE created_at END) INTO due
      FROM public.tool_actions
      WHERE state IN ('prepared','dispatched','outcome_unknown');
    WHEN 'retrieval' THEN
      SELECT min(CASE WHEN state='leased' THEN lease_until ELSE available_at END) INTO due
      FROM public.retrieval_jobs
      WHERE state IN ('pending','leased');
    WHEN 'embeddings' THEN
      SELECT min(CASE WHEN state='leased' THEN lease_until ELSE available_at END) INTO due
      FROM public.retrieval_embedding_jobs
      WHERE state IN ('pending','leased');
    WHEN 'knowledge' THEN
      SELECT min(next_at) INTO due
      FROM public.knowledge_schedules
      WHERE enabled;
    WHEN 'messages' THEN
      SELECT min(send_at) INTO due
      FROM public.scheduled_messages
      WHERE status='scheduled';
    WHEN 'scheduling' THEN
      SELECT min(at) INTO due
      FROM ( SELECT next_run_at at
      FROM public.task_recurrences
      WHERE NOT paused
      UNION ALL SELECT ((t.due_date-r.days_before)+r.local_time) AT TIME ZONE r.time_zone
      FROM public.task_reminders r
      JOIN public.tasks t ON t.workspace_id=r.workspace_id
      AND t.id=r.task_id
      WHERE r.enabled
      AND t.due_date IS NOT NULL
      AND t.state NOT IN ('completed','cancelled')
      AND NOT EXISTS(SELECT 1
      FROM public.task_reminder_deliveries d
      WHERE d.workspace_id=t.workspace_id
      AND d.task_id=t.id
      AND d.reminder_version=r.version
      AND d.due_version=t.due_version
      AND d.assignment_version=t.assignment_version) ) q;
    WHEN 'notifications' THEN
      SELECT min(at) INTO due
      FROM ( SELECT CASE WHEN state='sending' THEN lease_expires_at ELSE available_at END at
      FROM public.notification_deliveries
      WHERE state IN ('queued','sending')
      UNION ALL SELECT created_at
      FROM public.notifications n
      WHERE created_at>now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1
      FROM public.notification_delivery_plans p
      WHERE p.workspace_id=n.workspace_id
      AND p.notification_id=n.id) ) q;
    WHEN 'connections' THEN
      SELECT min(at) INTO due
      FROM ( SELECT CASE WHEN state='leased' THEN lease_until ELSE available_at END at
      FROM public.connection_events
      WHERE state IN ('pending','leased')
      UNION ALL SELECT CASE WHEN state='sending' THEN lease_until ELSE available_at END
      FROM public.connection_deliveries
      WHERE state IN ('pending','sending') ) q;
    WHEN 'developer-webhooks' THEN
      SELECT min(at) INTO due
      FROM (SELECT CASE WHEN state='sending' THEN lease_expires_at ELSE available_at END at
      FROM public.developer_deliveries
      WHERE state IN ('pending','sending')
      UNION ALL SELECT e.created_at
      FROM public.outbox_events e
      JOIN public.developer_webhooks w ON w.workspace_id=e.workspace_id
      AND w.enabled
      AND e.id>w.cursor) candidates;
    WHEN 'agent-delivery' THEN
      SELECT min(CASE WHEN state='sending' THEN lease_expires_at ELSE available_at END) INTO due
      FROM public.agent_wakeups
      WHERE state IN ('pending','sending');
    WHEN 'automations' THEN
      SELECT min(at) INTO due
      FROM (SELECT next_at at
      FROM public.automations
      WHERE status='active'
      UNION ALL SELECT e.created_at
      FROM public.outbox_events e
      JOIN public.automations a ON a.workspace_id=e.workspace_id
      AND a.status='active'
      AND e.id>a.event_cursor
      UNION ALL SELECT deadline_at
      FROM public.automation_occurrences
      WHERE status='running'
      UNION ALL SELECT scheduled_at
      FROM public.automation_occurrences
      WHERE status='queued') q;
    WHEN 'workflows' THEN
      SELECT min(at) INTO due
      FROM (SELECT available_at at
      FROM public.workflow_runs
      WHERE status IN ('queued','running','waiting')
      UNION ALL SELECT created_at
      FROM public.workflow_events
      WHERE processed_at IS NULL) q;
    WHEN 'calendar' THEN
      SELECT min(greatest(next_sync_at,coalesce(lease_expires_at,next_sync_at))) INTO due
      FROM public.calendar_connections
      WHERE status='active';
    WHEN 'migrations' THEN
      SELECT min(at) INTO due
      FROM (SELECT r.created_at at
      FROM public.migration_records r
      JOIN public.migration_sources s ON s.id=r.source_id
      WHERE r.state='pending'
      AND s.state='active'
      UNION ALL SELECT d.created_at
      FROM public.migration_deliveries d
      JOIN public.migration_sources s ON s.id=d.source_id
      WHERE d.state='pending'
      AND s.state='active'
      UNION ALL SELECT lease_until
      FROM public.migration_deliveries
      WHERE state='leased') candidates;
    WHEN 'billing' THEN
      SELECT min(at) INTO due
      FROM (SELECT greatest(available_at,coalesce(lease_until,available_at)) at
      FROM public.billing_events
      WHERE state='pending'
      UNION ALL SELECT greatest(reconcile_after,coalesce(reconcile_lease_until,reconcile_after))
      FROM public.billing_accounts
      WHERE provider_subscription_id IS NOT NULL) q;
    WHEN 'files' THEN
      SELECT min(greatest(cleanup_after,coalesce(lease_expires_at,cleanup_after),CASE WHEN status IN ('pending','ready') THEN expires_at ELSE cleanup_after END)) INTO due
      FROM public.files
      WHERE status IN ('pending','ready','uploading','rejected','deleting') OR status='deleted'
      AND purged_at>now()-interval '7 days';
    WHEN 'calls' THEN
      SELECT min(at) INTO due
      FROM (SELECT expires_at at
      FROM public.call_participants
      WHERE state='joined'
      UNION ALL SELECT expires_at
      FROM public.calls
      WHERE recording_deleted_at IS NULL) q;
    WHEN 'lifecycle' THEN
      SELECT min(greatest(available_at,coalesce(lease_until,available_at))) INTO due
      FROM public.lifecycle_jobs
      WHERE state IN ('pending','leased','held','waiting_storage','waiting_receipts');
    ELSE due:=NULL;
  END CASE;
  RETURN least(coalesce(due,now()+interval '1 day'),now()+interval '1 day');
END $body$;
REVOKE ALL ON FUNCTION background_next_at(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION background_next_at(text) TO ao_dispatcher;
