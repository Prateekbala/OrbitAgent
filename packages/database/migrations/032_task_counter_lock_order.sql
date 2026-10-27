CREATE OR REPLACE FUNCTION guard_task_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project projects%ROWTYPE; milestone project_milestones%ROWTYPE; placement boolean;
BEGIN
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
END $$;
