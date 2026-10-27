ALTER TABLE files ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE files ADD COLUMN task_id uuid;
ALTER TABLE files ADD CONSTRAINT files_task_reference FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id);
ALTER TABLE files ADD CONSTRAINT files_source_required CHECK(task_id IS NOT NULL OR conversation_id IS NOT NULL);
ALTER TABLE files ADD CONSTRAINT files_task_identity UNIQUE(workspace_id,task_id,id);
CREATE INDEX files_task_source ON files(workspace_id,task_id,id) WHERE task_id IS NOT NULL;
CREATE FUNCTION guard_file_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.conversation_id,NEW.task_id,NEW.uploader_id,NEW.client_id) IS DISTINCT FROM (OLD.workspace_id,OLD.conversation_id,OLD.task_id,OLD.uploader_id,OLD.client_id) THEN RAISE EXCEPTION 'Immutable file source'; END IF;
 IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND t.conversation_id IS NOT DISTINCT FROM NEW.conversation_id) THEN RAISE EXCEPTION 'Task file audience mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_source BEFORE INSERT OR UPDATE ON files FOR EACH ROW EXECUTE FUNCTION guard_file_source();
CREATE FUNCTION guard_message_file_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM files WHERE workspace_id=NEW.workspace_id AND id=NEW.file_id AND task_id IS NOT NULL) THEN RAISE EXCEPTION 'Task files cannot be attached to messages'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER message_file_source BEFORE INSERT OR UPDATE ON message_attachments FOR EACH ROW EXECUTE FUNCTION guard_message_file_source();
CREATE TABLE task_attachments (
 workspace_id uuid NOT NULL, task_id uuid NOT NULL, file_id uuid NOT NULL,
 attached_by uuid NOT NULL, attached_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz, removed_by uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(workspace_id,task_id,file_id), UNIQUE(workspace_id,file_id),
 FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id),
 FOREIGN KEY(workspace_id,task_id,file_id) REFERENCES files(workspace_id,task_id,id),
 FOREIGN KEY(workspace_id,attached_by) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,removed_by) REFERENCES memberships(workspace_id,id),
 CHECK((removed_at IS NULL)=(removed_by IS NULL))
);
CREATE INDEX task_attachments_live ON task_attachments(workspace_id,task_id,file_id) WHERE removed_at IS NULL;
CREATE FUNCTION guard_task_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ((NEW.workspace_id,NEW.task_id,NEW.file_id,NEW.attached_by,NEW.attached_at) IS DISTINCT FROM (OLD.workspace_id,OLD.task_id,OLD.file_id,OLD.attached_by,OLD.attached_at) OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Invalid attachment removal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_attachment_identity BEFORE UPDATE ON task_attachments FOR EACH ROW EXECUTE FUNCTION guard_task_attachment();
CREATE TABLE task_bulk_requests (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, client_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,actor_id,client_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['task_attachments','task_bulk_requests'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ao_runtime,ao_worker',relation);
 END LOOP;
END $$;
GRANT UPDATE ON task_attachments TO ao_runtime,ao_worker;
REVOKE ALL ON FUNCTION guard_file_source(),guard_message_file_source(),guard_task_attachment() FROM PUBLIC;
