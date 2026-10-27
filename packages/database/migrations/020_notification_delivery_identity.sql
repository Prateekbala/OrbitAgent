ALTER TABLE notifications ADD COLUMN delivery_version integer NOT NULL DEFAULT 0 CHECK(delivery_version>=0);
DO $notification_key$
DECLARE item record;
BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='notifications'::regclass AND contype='u'
 LOOP
  EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I',item.conname);
 END LOOP;
END
$notification_key$;
ALTER TABLE notifications ADD CONSTRAINT notification_delivery_unique UNIQUE NULLS NOT DISTINCT(workspace_id,recipient_id,kind,resource_id,actor_id,conversation_id,delivery_version);
