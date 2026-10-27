ALTER TABLE workspaces ADD COLUMN storage_limit_bytes bigint NOT NULL DEFAULT 5368709120 CHECK(storage_limit_bytes>0);
ALTER TABLE workspaces ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 0 CHECK(storage_bytes>=0);
CREATE TABLE files (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 uploader_id uuid NOT NULL,
 client_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 26214400),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 content_type text NOT NULL DEFAULT 'application/octet-stream',
 storage_provider text NOT NULL CHECK(storage_provider IN ('local','s3')),
 object_key text NOT NULL UNIQUE,
 preview_key text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','ready','attached','rejected','deleting','deleted')),
 scan_status text NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','development_only','infected')),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=0),
 lease_token uuid,
 lease_expires_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(),
 cleanup_after timestamptz NOT NULL DEFAULT now(),
 purged_at timestamptz,
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,conversation_id,id),
 UNIQUE(workspace_id,uploader_id,client_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,uploader_id) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX files_cleanup ON files(workspace_id,cleanup_after) WHERE status<>'attached';
CREATE TABLE message_attachments (
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 message_id uuid NOT NULL,
 file_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 PRIMARY KEY(workspace_id,message_id,ordinal),
 UNIQUE(workspace_id,file_id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,file_id) REFERENCES files(workspace_id,conversation_id,id)
);
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON files,message_attachments TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON files TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON message_attachments TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
ALTER TABLE messages ADD COLUMN creation_attachment_hash text NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK(
 (deleted_at IS NULL AND deleted_by IS NULL AND length(body) BETWEEN 0 AND 12000)
 OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND body='')
);
CREATE FUNCTION require_message_content() RETURNS trigger LANGUAGE plpgsql AS $content$
DECLARE target uuid;
BEGIN
 target=CASE WHEN TG_TABLE_NAME='messages' THEN NEW.id ELSE OLD.message_id END;
 IF EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=COALESCE(NEW.workspace_id,OLD.workspace_id) AND m.id=target AND m.deleted_at IS NULL AND m.body='' AND NOT EXISTS(SELECT 1 FROM message_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id)) THEN
  RAISE EXCEPTION 'A message requires text or an attachment' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END
$content$;
REVOKE ALL ON FUNCTION require_message_content() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER message_content AFTER INSERT OR UPDATE ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_message_content();
CREATE CONSTRAINT TRIGGER attachment_content AFTER DELETE ON message_attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_message_content();
