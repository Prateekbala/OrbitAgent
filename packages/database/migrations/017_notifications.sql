CREATE TABLE notification_preferences (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 mentions boolean NOT NULL DEFAULT true,
 replies boolean NOT NULL DEFAULT true,
 direct_messages boolean NOT NULL DEFAULT true,
 group_messages boolean NOT NULL DEFAULT true,
 reactions boolean NOT NULL DEFAULT true,
 tasks boolean NOT NULL DEFAULT true,
 approvals boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,membership_id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE conversation_notification_preferences (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 mode text NOT NULL DEFAULT 'default' CHECK(mode IN ('default','all','mentions','muted')),
 PRIMARY KEY(workspace_id,membership_id,conversation_id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE message_mentions (
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 message_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,message_id,membership_id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE messages ADD COLUMN creation_mention_hash text NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
CREATE TABLE notifications (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 recipient_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 conversation_id uuid,
 resource_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('message','mention','reply','reaction','task_assigned','approval_request','group_added')),
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,recipient_id,kind,resource_id,actor_id),
 FOREIGN KEY(workspace_id,recipient_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX notifications_inbox ON notifications(workspace_id,recipient_id,sequence DESC);
CREATE INDEX notifications_unread ON notifications(workspace_id,recipient_id,sequence DESC) WHERE read_at IS NULL;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notification_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE message_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_mentions FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_preferences,conversation_notification_preferences,message_mentions,notifications TO ao_runtime,ao_worker;
GRANT USAGE,SELECT ON SEQUENCE notifications_sequence_seq TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON notification_preferences TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON conversation_notification_preferences TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON message_mentions TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY tenant_boundary ON notifications TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
