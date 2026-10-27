ALTER TABLE messages ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE messages ADD COLUMN edited_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_by uuid;
ALTER TABLE messages ADD CONSTRAINT messages_deleted_by_fk FOREIGN KEY(workspace_id,deleted_by) REFERENCES memberships(workspace_id,id);
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK(
 (deleted_at IS NULL AND deleted_by IS NULL AND length(body) BETWEEN 1 AND 12000)
 OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND body='')
);
ALTER TABLE messages ADD COLUMN creation_body_hash text;
UPDATE messages SET creation_body_hash=encode(sha256(convert_to(body,'UTF8')),'hex');
ALTER TABLE messages ALTER COLUMN creation_body_hash SET NOT NULL;
CREATE FUNCTION set_message_creation_hash() RETURNS trigger LANGUAGE plpgsql AS $hash$
BEGIN
 NEW.creation_body_hash=encode(sha256(convert_to(NEW.body,'UTF8')),'hex');
 RETURN NEW;
END
$hash$;
REVOKE ALL ON FUNCTION set_message_creation_hash() FROM PUBLIC;
CREATE TRIGGER message_creation_hash BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION set_message_creation_hash();

CREATE TABLE message_reactions (
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 message_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 emoji text NOT NULL CHECK(emoji IN ('👍','❤️','🎉','😄','👀','🚀','✅','🙏','🔥','💡','😂','😕')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id,membership_id,emoji),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE conversation_reads (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 thread_id uuid,
 last_message_id uuid NOT NULL,
 last_sequence integer NOT NULL CHECK(last_sequence>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT conversation_reads_scope UNIQUE NULLS NOT DISTINCT(workspace_id,conversation_id,membership_id,thread_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id,thread_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,last_message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE INDEX conversation_reads_receipts ON conversation_reads(workspace_id,conversation_id,thread_id,last_sequence);
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_reads FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON message_reactions,conversation_reads TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON message_reactions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON conversation_reads TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);

CREATE TABLE realtime_heads (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces,
 next_sequence bigint NOT NULL DEFAULT 0 CHECK(next_sequence>=0)
);
ALTER TABLE realtime_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_heads FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON realtime_heads TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON realtime_heads TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
ALTER TABLE outbox_events ADD COLUMN stream_sequence bigint;
CREATE UNIQUE INDEX outbox_stream_sequence ON outbox_events(workspace_id,stream_sequence);
CREATE INDEX outbox_unpublished ON outbox_events(workspace_id,id) WHERE stream_sequence IS NULL;
