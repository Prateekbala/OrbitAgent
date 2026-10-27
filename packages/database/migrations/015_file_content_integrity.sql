CREATE OR REPLACE FUNCTION require_message_content() RETURNS trigger LANGUAGE plpgsql AS $content$
DECLARE target uuid; tenant uuid;
BEGIN
 IF TG_TABLE_NAME='messages' THEN
  target=NEW.id; tenant=NEW.workspace_id;
 ELSE
  target=OLD.message_id; tenant=OLD.workspace_id;
 END IF;
 IF EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=tenant AND m.id=target AND m.deleted_at IS NULL AND m.body='' AND NOT EXISTS(SELECT 1 FROM message_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id)) THEN
  RAISE EXCEPTION 'A message requires text or an attachment' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END
$content$;
