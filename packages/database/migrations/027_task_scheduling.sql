ALTER TABLE tasks ADD COLUMN due_version integer NOT NULL DEFAULT 1 CHECK(due_version>0);
CREATE FUNCTION stamp_task_due_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.due_version := OLD.due_version + CASE WHEN NEW.due_date IS DISTINCT FROM OLD.due_date THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
CREATE TRIGGER stamp_task_due BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION stamp_task_due_version();

CREATE TABLE task_recurrences (
 id uuid NOT NULL UNIQUE,
 workspace_id uuid NOT NULL,
 task_id uuid NOT NULL,
 created_by uuid NOT NULL,
 frequency text NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
 interval integer NOT NULL CHECK(interval BETWEEN 1 AND 365),
 start_date date NOT NULL CHECK(start_date BETWEEN date '0001-01-01' AND date '9999-12-31'),
 end_date date CHECK(end_date BETWEEN start_date AND date '9999-12-31'),
 time_zone text NOT NULL,
 local_time time NOT NULL,
 next_date date CHECK(next_date BETWEEN start_date AND date '9999-12-31'),
 next_run_at timestamptz,
 occurrence_index integer NOT NULL DEFAULT 0 CHECK(occurrence_index>=0),
 occurrence_count integer NOT NULL DEFAULT 0 CHECK(occurrence_count>=0),
 paused boolean NOT NULL DEFAULT false,
 paused_reason text,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(workspace_id,task_id), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),
 CHECK((next_date IS NULL)=(next_run_at IS NULL)),
 CHECK(end_date IS NULL OR next_date<=end_date)
);
CREATE INDEX task_recurrences_ready ON task_recurrences(workspace_id,next_run_at,id) WHERE NOT paused AND next_run_at IS NOT NULL;
CREATE TABLE task_occurrences (
 workspace_id uuid NOT NULL, recurrence_id uuid NOT NULL, task_id uuid NOT NULL,
 occurrence_date date NOT NULL,
 PRIMARY KEY(workspace_id,recurrence_id,occurrence_date), UNIQUE(workspace_id,task_id),
 FOREIGN KEY(workspace_id,recurrence_id) REFERENCES task_recurrences(workspace_id,id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE task_reminders (
 workspace_id uuid NOT NULL, task_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true,
 days_before integer NOT NULL DEFAULT 0 CHECK(days_before BETWEEN 0 AND 365),
 local_time time NOT NULL DEFAULT '09:00', time_zone text NOT NULL DEFAULT 'UTC',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(workspace_id,task_id), FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE task_reminder_deliveries (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, task_id uuid NOT NULL,
 recipient_id uuid NOT NULL, reminder_version integer NOT NULL CHECK(reminder_version>0),
 due_version integer NOT NULL CHECK(due_version>0), assignment_version integer NOT NULL CHECK(assignment_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,task_id,reminder_version,due_version,assignment_version),
 FOREIGN KEY(workspace_id,task_id) REFERENCES task_reminders(workspace_id,task_id),
 FOREIGN KEY(workspace_id,recipient_id) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX task_due_reminders ON tasks(workspace_id,due_date,id) WHERE due_date IS NOT NULL AND state NOT IN ('completed','cancelled');

CREATE FUNCTION guard_task_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.time_zone) THEN RAISE EXCEPTION 'Unknown time zone'; END IF;
 IF NEW.local_time::text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:00$' THEN RAISE EXCEPTION 'Minute precision is required'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.task_id) IS DISTINCT FROM (OLD.workspace_id,OLD.task_id) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid schedule revision'; END IF;
  IF TG_TABLE_NAME='task_recurrences' THEN
   IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Immutable recurrence identity'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_task_recurrence BEFORE INSERT OR UPDATE ON task_recurrences FOR EACH ROW EXECUTE FUNCTION guard_task_schedule();
CREATE TRIGGER guard_task_reminder BEFORE INSERT OR UPDATE ON task_reminders FOR EACH ROW EXECUTE FUNCTION guard_task_schedule();
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['task_recurrences','task_occurrences','task_reminders','task_reminder_deliveries'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ao_runtime,ao_worker',relation);
 END LOOP;
END $$;
GRANT UPDATE ON task_recurrences,task_reminders TO ao_runtime,ao_worker;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('message','mention','reply','reaction','task_assigned','task_comment','task_reminder','approval_request','group_added'));
