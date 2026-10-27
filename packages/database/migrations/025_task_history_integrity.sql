REVOKE DELETE ON task_comments FROM ao_runtime,ao_worker;
REVOKE UPDATE ON task_dependencies FROM ao_runtime,ao_worker;
REVOKE UPDATE,DELETE ON task_transitions FROM ao_runtime,ao_worker;
ALTER TABLE task_comments ADD CONSTRAINT task_comment_hash CHECK(creation_body_hash ~ '^[a-f0-9]{64}$');
CREATE FUNCTION protect_task_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Task transition history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER task_transition_immutable BEFORE UPDATE OR DELETE ON task_transitions FOR EACH ROW EXECUTE FUNCTION protect_task_transition();
REVOKE ALL ON FUNCTION protect_task_transition() FROM PUBLIC;
