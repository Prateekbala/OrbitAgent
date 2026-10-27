CREATE TABLE projects (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, conversation_id uuid,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 160), description text NOT NULL DEFAULT '' CHECK(length(description)<=12000),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','paused','completed','archived')),
 owner_id uuid NOT NULL, created_by uuid NOT NULL,
 start_date date CHECK(start_date BETWEEN date '0001-01-01' AND date '9999-12-31'),
 target_date date CHECK(target_date BETWEEN date '0001-01-01' AND date '9999-12-31'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 client_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,created_by,client_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),
 CHECK(start_date IS NULL OR target_date IS NULL OR start_date<=target_date)
);
CREATE INDEX projects_scope ON projects(workspace_id,conversation_id,status,id);
CREATE TABLE project_milestones (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 2 AND 160), description text NOT NULL DEFAULT '' CHECK(length(description)<=12000),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','completed','cancelled')),
 due_date date CHECK(due_date BETWEEN date '0001-01-01' AND date '9999-12-31'),
 created_by uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 client_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,project_id,id), UNIQUE(workspace_id,created_by,client_id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX milestones_project ON project_milestones(workspace_id,project_id,id);
CREATE TABLE work_labels (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
 color text NOT NULL CHECK(color IN ('sage','blue','amber','rose','violet','slate')), archived boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 client_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,created_by,client_id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE UNIQUE INDEX labels_unique_name ON work_labels(workspace_id,lower(name));
CREATE INDEX labels_listing ON work_labels(workspace_id,archived,id);
ALTER TABLE tasks ADD COLUMN project_id uuid;
ALTER TABLE tasks ADD COLUMN milestone_id uuid;
ALTER TABLE tasks ADD CONSTRAINT task_project_fk FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id);
ALTER TABLE tasks ADD CONSTRAINT task_milestone_fk FOREIGN KEY(workspace_id,project_id,milestone_id) REFERENCES project_milestones(workspace_id,project_id,id);
ALTER TABLE tasks ADD CONSTRAINT task_milestone_project CHECK(milestone_id IS NULL OR project_id IS NOT NULL);
CREATE INDEX tasks_project ON tasks(workspace_id,project_id,state,id) WHERE project_id IS NOT NULL;
CREATE INDEX tasks_milestone ON tasks(workspace_id,milestone_id,state,id) WHERE milestone_id IS NOT NULL;
CREATE TABLE task_label_links (
 workspace_id uuid NOT NULL, task_id uuid NOT NULL, label_id uuid NOT NULL, assigned_by uuid NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,task_id,label_id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,label_id) REFERENCES work_labels(workspace_id,id),
 FOREIGN KEY(workspace_id,assigned_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX task_labels_filter ON task_label_links(workspace_id,label_id,task_id);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['projects','project_milestones','work_labels','task_label_links'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ao_runtime,ao_worker',relation);
 END LOOP;
END $$;
GRANT UPDATE ON projects,project_milestones,work_labels TO ao_runtime,ao_worker;
GRANT DELETE ON task_label_links TO ao_runtime,ao_worker;
CREATE FUNCTION guard_organization_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM lock_task_graph(NEW.workspace_id);
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.created_by,NEW.created_at,NEW.client_id,NEW.request_hash) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.created_by,OLD.created_at,OLD.client_id,OLD.request_hash) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Invalid organization revision'; END IF;
  IF TG_TABLE_NAME='projects' THEN IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN RAISE EXCEPTION 'Immutable project audience'; END IF; END IF;
  IF TG_TABLE_NAME='project_milestones' THEN IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'Immutable milestone project'; END IF; END IF;
  NEW.updated_at=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_revision BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION guard_organization_entity();
CREATE TRIGGER milestone_revision BEFORE INSERT OR UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION guard_organization_entity();
CREATE TRIGGER label_revision BEFORE INSERT OR UPDATE ON work_labels FOR EACH ROW EXECUTE FUNCTION guard_organization_entity();
CREATE FUNCTION guard_task_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project projects%ROWTYPE; milestone project_milestones%ROWTYPE; placement boolean;
BEGIN
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
END $$;
CREATE TRIGGER task_organization BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_task_organization();
CREATE FUNCTION assert_project_completion(ws uuid,project uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF project IS NULL THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM projects WHERE workspace_id=ws AND id=project AND status='completed') AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=ws AND project_id=project AND state NOT IN ('completed','cancelled')) THEN RAISE EXCEPTION 'Close all project tasks before completing the project' USING ERRCODE='AOP04'; END IF;
 IF EXISTS(SELECT 1 FROM project_milestones m JOIN tasks t ON t.workspace_id=m.workspace_id AND t.milestone_id=m.id WHERE m.workspace_id=ws AND m.project_id=project AND m.status='completed' AND t.state NOT IN ('completed','cancelled')) THEN RAISE EXCEPTION 'Close all milestone tasks before completing the milestone' USING ERRCODE='AOP05'; END IF;
END $$;
CREATE FUNCTION check_project_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='projects' THEN PERFORM assert_project_completion(NEW.workspace_id,NEW.id);
 ELSE
  IF TG_TABLE_NAME='tasks' AND TG_OP='UPDATE' THEN IF NEW.version=OLD.version THEN RETURN NULL; END IF; END IF;
  PERFORM assert_project_completion(NEW.workspace_id,NEW.project_id);
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER project_completion AFTER INSERT OR UPDATE ON projects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_project_completion();
CREATE CONSTRAINT TRIGGER milestone_completion AFTER INSERT OR UPDATE ON project_milestones DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_project_completion();
CREATE CONSTRAINT TRIGGER task_project_completion AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_project_completion();
CREATE FUNCTION guard_task_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM lock_task_graph(OLD.workspace_id); RETURN OLD; END IF;
 PERFORM lock_task_graph(NEW.workspace_id);
 IF EXISTS(SELECT 1 FROM work_labels WHERE workspace_id=NEW.workspace_id AND id=NEW.label_id AND archived) THEN RAISE EXCEPTION 'Archived label cannot be assigned' USING ERRCODE='AOP06'; END IF;
 IF (SELECT count(*) FROM task_label_links WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id)>=20 THEN RAISE EXCEPTION 'A task supports at most 20 labels' USING ERRCODE='AOP07'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_label_guard BEFORE INSERT OR DELETE ON task_label_links FOR EACH ROW EXECUTE FUNCTION guard_task_label();
REVOKE ALL ON FUNCTION guard_organization_entity(),guard_task_organization(),guard_task_label(),check_project_completion(),assert_project_completion(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_project_completion(uuid,uuid) TO ao_runtime,ao_worker;
