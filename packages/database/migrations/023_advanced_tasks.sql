ALTER TABLE tasks ADD COLUMN parent_id uuid;
ALTER TABLE tasks ADD COLUMN due_date date;
ALTER TABLE tasks ADD COLUMN created_by uuid;
ALTER TABLE tasks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks ADD COLUMN next_comment_sequence integer NOT NULL DEFAULT 0 CHECK(next_comment_sequence>=0);
ALTER TABLE tasks ADD COLUMN create_request_id uuid;
ALTER TABLE tasks ADD COLUMN create_request_hash text;
UPDATE tasks t SET created_by=(SELECT a.actor_id FROM audit_events a WHERE a.workspace_id=t.workspace_id AND a.resource_id=t.id AND a.action='task.created' ORDER BY a.created_at,a.id LIMIT 1),updated_at=t.created_at;
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_fk FOREIGN KEY(workspace_id,parent_id) REFERENCES tasks(workspace_id,id);
ALTER TABLE tasks ADD CONSTRAINT tasks_creator_fk FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id);
ALTER TABLE tasks ADD CONSTRAINT tasks_not_own_parent CHECK(parent_id IS DISTINCT FROM id);
ALTER TABLE tasks ADD CONSTRAINT tasks_version_positive CHECK(version>0);
ALTER TABLE tasks ADD CONSTRAINT tasks_create_request UNIQUE(workspace_id,created_by,create_request_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_create_request_pair CHECK((create_request_id IS NULL)=(create_request_hash IS NULL));
CREATE INDEX tasks_parent ON tasks(workspace_id,parent_id,id);
CREATE INDEX tasks_due ON tasks(workspace_id,due_date,id) WHERE state NOT IN ('completed','cancelled');
CREATE INDEX tasks_created ON tasks(workspace_id,created_at DESC,id DESC);
CREATE INDEX tasks_assignee ON tasks(workspace_id,assignee_id,created_at DESC,id DESC);

CREATE TABLE task_dependencies (
 workspace_id uuid NOT NULL,
 task_id uuid NOT NULL,
 depends_on_id uuid NOT NULL,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,task_id,depends_on_id),
 CHECK(task_id<>depends_on_id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,depends_on_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX task_dependents ON task_dependencies(workspace_id,depends_on_id,task_id);
CREATE TABLE task_comments (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 task_id uuid NOT NULL,
 author_id uuid NOT NULL,
 body text NOT NULL,
 client_id uuid NOT NULL,
 creation_body_hash text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 edited_at timestamptz,
 deleted_at timestamptz,
 deleted_by uuid,
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,task_id,sequence),
 UNIQUE(workspace_id,task_id,author_id,client_id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,author_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,deleted_by) REFERENCES memberships(workspace_id,id),
 CHECK((deleted_at IS NULL AND deleted_by IS NULL AND length(body) BETWEEN 1 AND 12000) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND body=''))
);
CREATE INDEX task_comments_timeline ON task_comments(workspace_id,task_id,sequence DESC);
ALTER TABLE task_transitions ADD COLUMN task_version integer;
WITH numbered AS(SELECT id,row_number() OVER(PARTITION BY workspace_id,task_id ORDER BY created_at,id)+1 version FROM task_transitions)
UPDATE task_transitions t SET task_version=n.version FROM numbered n WHERE n.id=t.id;
ALTER TABLE task_transitions ALTER COLUMN task_version SET NOT NULL;
ALTER TABLE task_transitions ADD CONSTRAINT task_transition_version UNIQUE(workspace_id,task_id,task_version);
CREATE INDEX task_transitions_timeline ON task_transitions(workspace_id,task_id,task_version DESC);
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies FORCE ROW LEVEL SECURITY;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_comments FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON task_dependencies,task_comments TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON task_dependencies TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON task_comments TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

CREATE FUNCTION lock_task_graph(target_workspace uuid) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended(target_workspace::text,71423));
$$;
CREATE FUNCTION assert_task_graph(target_workspace uuid,target_task uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM tasks child JOIN tasks parent ON parent.workspace_id=child.workspace_id AND parent.id=child.parent_id WHERE child.workspace_id=target_workspace AND (child.id=target_task OR parent.id=target_task) AND child.conversation_id IS DISTINCT FROM parent.conversation_id)
 OR EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks a ON a.workspace_id=d.workspace_id AND a.id=d.task_id JOIN tasks b ON b.workspace_id=d.workspace_id AND b.id=d.depends_on_id WHERE d.workspace_id=target_workspace AND (a.id=target_task OR b.id=target_task) AND a.conversation_id IS DISTINCT FROM b.conversation_id) THEN
  RAISE EXCEPTION 'Related tasks must share the same audience' USING ERRCODE='AOT02';
 END IF;
 IF EXISTS(WITH RECURSIVE edges AS(
    SELECT task_id source,depends_on_id target FROM task_dependencies WHERE workspace_id=target_workspace
    UNION ALL SELECT parent_id,id FROM tasks WHERE workspace_id=target_workspace AND parent_id IS NOT NULL
   ), reachable(node) AS(
    SELECT target FROM edges WHERE source=target_task
    UNION SELECT e.target FROM edges e JOIN reachable r ON e.source=r.node
   ) SELECT 1 FROM reachable WHERE node=target_task) THEN
  RAISE EXCEPTION 'This relationship would create a task cycle' USING ERRCODE='AOT01';
 END IF;
 IF EXISTS(SELECT 1 FROM tasks t JOIN task_dependencies d ON d.workspace_id=t.workspace_id AND d.task_id=t.id JOIN tasks prerequisite ON prerequisite.workspace_id=d.workspace_id AND prerequisite.id=d.depends_on_id
   WHERE t.workspace_id=target_workspace AND (t.id=target_task OR prerequisite.id=target_task) AND t.state IN ('active','awaiting_approval','awaiting_review','completed') AND prerequisite.state<>'completed') THEN
  RAISE EXCEPTION 'Finish prerequisites before starting or completing dependent work' USING ERRCODE='AOT03';
 END IF;
 IF EXISTS(SELECT 1 FROM tasks parent JOIN tasks child ON child.workspace_id=parent.workspace_id AND child.parent_id=parent.id WHERE parent.workspace_id=target_workspace AND (parent.id=target_task OR child.id=target_task) AND parent.state IN ('completed','cancelled') AND child.state NOT IN ('completed','cancelled')) THEN
  RAISE EXCEPTION 'Close all subtasks before completing or cancelling their parent' USING ERRCODE='AOT04';
 END IF;
END;
$$;
CREATE FUNCTION guard_task_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
$$;
CREATE TRIGGER task_write_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_write();
CREATE FUNCTION guard_task_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM lock_task_graph(COALESCE(NEW.workspace_id,OLD.workspace_id));
 RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER task_dependency_guard BEFORE INSERT OR UPDATE OR DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION guard_task_dependency();
CREATE FUNCTION check_task_graph() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='task_dependencies' THEN PERFORM assert_task_graph(NEW.workspace_id,NEW.task_id);
 ELSE PERFORM assert_task_graph(NEW.workspace_id,NEW.id); END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER task_graph_consistency AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task_graph();
CREATE CONSTRAINT TRIGGER task_dependency_consistency AFTER INSERT OR UPDATE ON task_dependencies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task_graph();
CREATE FUNCTION guard_task_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.creation_body_hash IS DISTINCT FROM OLD.creation_body_hash OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'Task comment identity and deleted content are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER task_comment_guard BEFORE UPDATE ON task_comments FOR EACH ROW EXECUTE FUNCTION guard_task_comment();
REVOKE ALL ON FUNCTION lock_task_graph(uuid),assert_task_graph(uuid,uuid),guard_task_write(),guard_task_dependency(),check_task_graph(),guard_task_comment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_task_graph(uuid),assert_task_graph(uuid,uuid) TO ao_runtime,ao_worker;
