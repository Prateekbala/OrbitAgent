ALTER TABLE tasks ADD COLUMN assignment_version integer NOT NULL DEFAULT 1 CHECK(assignment_version>0);
ALTER TABLE tasks ADD CONSTRAINT tasks_due_calendar CHECK(due_date IS NULL OR due_date BETWEEN date '0001-01-01' AND date '9999-12-31');
CREATE FUNCTION stamp_task_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.assignment_version=OLD.assignment_version+CASE WHEN NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN 1 ELSE 0 END;
 RETURN NEW;
END;
$$;
CREATE TRIGGER task_assignment_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION stamp_task_assignment();
CREATE OR REPLACE FUNCTION check_task_graph() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='task_dependencies' THEN PERFORM assert_task_graph(NEW.workspace_id,NEW.task_id);
 ELSIF TG_OP='INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN PERFORM assert_task_graph(NEW.workspace_id,NEW.id);
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stamp_task_assignment() FROM PUBLIC;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('message','mention','reply','reaction','task_assigned','task_comment','approval_request','group_added'));
UPDATE notifications n SET delivery_version=t.assignment_version FROM tasks t WHERE n.workspace_id=t.workspace_id AND n.resource_id=t.id AND n.kind='task_assigned';
