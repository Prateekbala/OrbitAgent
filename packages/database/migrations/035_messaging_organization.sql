ALTER TABLE conversations ADD COLUMN archived_at timestamptz;
ALTER TABLE conversations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE memberships ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD COLUMN archived_by uuid;
ALTER TABLE conversations ADD COLUMN history_policy text NOT NULL DEFAULT 'retained' CHECK(history_policy IN ('retained','join_time'));
ALTER TABLE knowledge_pages ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE tasks ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE projects ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE agent_runs ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE audit_events ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE conversations ADD CONSTRAINT conversation_archiver FOREIGN KEY(workspace_id,archived_by) REFERENCES memberships(workspace_id,id);
ALTER TABLE conversation_members ADD COLUMN history_from_sequence integer NOT NULL DEFAULT 0 CHECK(history_from_sequence>=0);
ALTER TABLE conversation_members ALTER COLUMN history_from_sequence DROP DEFAULT;
REVOKE UPDATE ON conversation_members FROM ao_runtime,ao_worker;
GRANT UPDATE(role) ON conversation_members TO ao_runtime,ao_worker;
CREATE TABLE conversation_membership_intervals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,conversation_id uuid NOT NULL,membership_id uuid NOT NULL,
 joined_at timestamptz NOT NULL DEFAULT now(),left_at timestamptz,history_from_sequence integer NOT NULL CHECK(history_from_sequence>=0),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
INSERT INTO conversation_membership_intervals(workspace_id,conversation_id,membership_id,joined_at,history_from_sequence) SELECT workspace_id,conversation_id,membership_id,joined_at,0 FROM conversation_members;
CREATE UNIQUE INDEX conversation_active_interval ON conversation_membership_intervals(workspace_id,conversation_id,membership_id) WHERE left_at IS NULL;
CREATE FUNCTION conversation_membership_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE floor integer; channel record;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.joined_at=clock_timestamp();
  SELECT c.* INTO channel FROM public.conversations c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.conversation_id;
  IF channel.kind='group' AND channel.next_sequence>0 AND NOT EXISTS(SELECT 1 FROM public.conversation_members existing WHERE existing.workspace_id=NEW.workspace_id AND existing.conversation_id=NEW.conversation_id AND existing.membership_id=NEW.membership_id) THEN
   IF coalesce(current_setting('ao.group_membership_mutation',true),'')<>NEW.conversation_id::text THEN RAISE EXCEPTION 'Use group participant management to expand this audience' USING ERRCODE='AOM01'; END IF;
   IF coalesce(NEW.history_from_sequence,0)=0 AND NOT EXISTS(
    SELECT 1 FROM public.group_history_proposals h WHERE h.id=nullif(current_setting('ao.history_proposal_id',true),'')::uuid AND h.workspace_id=NEW.workspace_id AND h.conversation_id=NEW.conversation_id AND h.target_id=NEW.membership_id AND h.status='pending' AND h.base_version=channel.version AND h.expires_at>now()
    AND NOT EXISTS(SELECT 1 FROM unnest(h.voters) voter WHERE NOT EXISTS(SELECT 1 FROM public.group_history_votes v WHERE v.workspace_id=h.workspace_id AND v.proposal_id=h.id AND v.membership_id=voter AND v.decision='approve'))
    AND NOT EXISTS(SELECT 1 FROM public.conversation_members cm JOIN public.memberships m ON m.workspace_id=cm.workspace_id AND m.id=cm.membership_id WHERE cm.workspace_id=h.workspace_id AND cm.conversation_id=h.conversation_id AND m.kind='human' AND m.status='active' AND NOT(m.id=ANY(h.voters)))
   ) THEN RAISE EXCEPTION 'Participant consent is required for earlier history' USING ERRCODE='AOM02'; END IF;
  END IF;
  IF NEW.history_from_sequence IS NULL THEN
   SELECT CASE WHEN c.history_policy='join_time' THEN c.next_sequence+1 ELSE 0 END INTO floor FROM public.conversations c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.conversation_id;
   NEW.history_from_sequence=coalesce(floor,0);
  END IF;
  INSERT INTO public.conversation_membership_intervals(workspace_id,conversation_id,membership_id,history_from_sequence,joined_at) VALUES(NEW.workspace_id,NEW.conversation_id,NEW.membership_id,NEW.history_from_sequence,NEW.joined_at) ON CONFLICT DO NOTHING;
  RETURN NEW;
 END IF;
 UPDATE public.conversation_membership_intervals SET left_at=now() WHERE workspace_id=OLD.workspace_id AND conversation_id=OLD.conversation_id AND membership_id=OLD.membership_id AND left_at IS NULL;
 RETURN OLD;
END
$body$;
REVOKE ALL ON FUNCTION conversation_membership_history() FROM PUBLIC;
CREATE TRIGGER conversation_membership_history BEFORE INSERT OR DELETE ON conversation_members FOR EACH ROW EXECUTE FUNCTION conversation_membership_history();

CREATE FUNCTION message_visible_to(tenant uuid,conversation uuid,message_sequence integer,root uuid,member uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.conversations c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=member AND m.status='active'
 LEFT JOIN public.conversation_members cm ON cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id
 WHERE c.workspace_id=tenant AND c.id=conversation
 AND (cm.membership_id IS NOT NULL OR (c.visibility='public' AND m.access_type='member' AND c.history_policy='retained'))
 AND message_sequence>=coalesce(cm.history_from_sequence,0)
 AND (root IS NULL OR EXISTS(SELECT 1 FROM public.messages r WHERE r.workspace_id=tenant AND r.conversation_id=conversation AND r.id=root AND r.sequence>=coalesce(cm.history_from_sequence,0))))
$body$;
REVOKE ALL ON FUNCTION message_visible_to(uuid,uuid,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION message_visible_to(uuid,uuid,integer,uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION resource_visible_to(tenant uuid,conversation uuid,created timestamptz,member uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.memberships m WHERE m.workspace_id=tenant AND m.id=member AND m.status='active' AND (
 (conversation IS NULL AND m.access_type='member') OR EXISTS(
 SELECT 1 FROM public.conversations c LEFT JOIN public.conversation_members cm ON cm.workspace_id=c.workspace_id AND cm.conversation_id=c.id AND cm.membership_id=m.id
 WHERE c.workspace_id=tenant AND c.id=conversation AND (cm.membership_id IS NOT NULL OR (c.visibility='public' AND m.access_type='member' AND c.history_policy='retained'))
 AND (coalesce(cm.history_from_sequence,0)=0 OR created>=cm.joined_at))))
$body$;
REVOKE ALL ON FUNCTION resource_visible_to(uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_visible_to(uuid,uuid,timestamptz,uuid) TO ao_runtime,ao_worker;
DO $resource_history$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['tasks','projects','knowledge_pages','agent_runs','audit_events'] LOOP
  EXECUTE format('CREATE POLICY resource_history ON %I AS RESTRICTIVE FOR SELECT TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting(''ao.membership_id'',true),'''')::uuid))',name);
 END LOOP;
END
$resource_history$;
CREATE POLICY resource_history ON knowledge_versions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.workspace_id=knowledge_versions.workspace_id AND p.id=page_id));
CREATE POLICY resource_history ON task_comments AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=task_comments.workspace_id AND t.id=task_id));
CREATE POLICY resource_history ON task_transitions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=task_transitions.workspace_id AND t.id=task_id));
CREATE POLICY resource_history ON task_attachments AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=task_attachments.workspace_id AND t.id=task_id));
CREATE POLICY resource_history ON task_dependencies AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=task_dependencies.workspace_id AND t.id=task_id) AND EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=task_dependencies.workspace_id AND t.id=depends_on_id));
CREATE POLICY resource_history ON project_milestones AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=project_milestones.workspace_id AND p.id=project_id));
CREATE POLICY resource_history ON files AS RESTRICTIVE FOR SELECT TO ao_runtime USING(task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=files.workspace_id AND t.id=task_id));
CREATE POLICY resource_history ON tool_invocations AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM agent_runs r WHERE r.workspace_id=tool_invocations.workspace_id AND r.id=run_id));
DO $task_resource_history$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['task_recurrences','task_reminders','task_occurrences','task_reminder_deliveries','task_label_links'] LOOP
  EXECUTE format('CREATE POLICY resource_history ON %I AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tasks t WHERE t.workspace_id=%I.workspace_id AND t.id=task_id))',name,name);
 END LOOP;
END
$task_resource_history$;
CREATE POLICY resource_history ON approval_decisions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM tool_invocations t WHERE t.workspace_id=approval_decisions.workspace_id AND t.id=invocation_id));
CREATE POLICY message_history ON messages AS RESTRICTIVE FOR SELECT TO ao_runtime USING(message_visible_to(workspace_id,conversation_id,sequence,thread_id,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY message_history ON message_attachments AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=message_attachments.workspace_id AND m.id=message_id));
CREATE POLICY message_history ON message_reactions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=message_reactions.workspace_id AND m.id=message_id));
CREATE POLICY message_history ON message_mentions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=message_mentions.workspace_id AND m.id=message_id));
CREATE POLICY message_history ON files AS RESTRICTIVE FOR SELECT TO ao_runtime USING(task_id IS NOT NULL OR status<>'attached' OR EXISTS(SELECT 1 FROM message_attachments a JOIN messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id WHERE a.workspace_id=files.workspace_id AND a.file_id=files.id));
CREATE POLICY message_history ON agent_inbox AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=agent_inbox.workspace_id AND m.id=message_id));

ALTER TABLE messages ADD COLUMN format text NOT NULL DEFAULT 'plain' CHECK(format IN ('plain','markdown'));
ALTER TABLE messages ADD COLUMN creation_format text NOT NULL DEFAULT 'plain' CHECK(creation_format IN ('plain','markdown'));
CREATE TABLE message_pins (
 workspace_id uuid NOT NULL,conversation_id uuid NOT NULL,message_id uuid NOT NULL,pinned_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,message_id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),FOREIGN KEY(workspace_id,pinned_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE saved_messages (
 workspace_id uuid NOT NULL,membership_id uuid NOT NULL,message_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,membership_id,message_id),
 FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE thread_followers (
 workspace_id uuid NOT NULL,membership_id uuid NOT NULL,message_id uuid NOT NULL,following boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,membership_id,message_id),
 FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE message_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,membership_id uuid NOT NULL,conversation_id uuid NOT NULL,thread_id uuid,
 body text NOT NULL CHECK(length(body)<=12000),format text NOT NULL CHECK(format IN ('plain','markdown')),attachment_ids uuid[] NOT NULL DEFAULT '{}',mention_ids uuid[] NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1 CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(workspace_id,membership_id,conversation_id,thread_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,conversation_id,thread_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE TABLE personal_sidebars (
 workspace_id uuid NOT NULL,membership_id uuid NOT NULL,sections jsonb NOT NULL DEFAULT '[]',hidden_ids uuid[] NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1 CHECK(version>0),PRIMARY KEY(workspace_id,membership_id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),CHECK(jsonb_typeof(sections)='array' AND octet_length(sections::text)<=100000)
);
CREATE TABLE scheduled_messages (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,membership_id uuid NOT NULL,conversation_id uuid NOT NULL,thread_id uuid,client_id uuid NOT NULL,
 body text NOT NULL CHECK(length(body)<=12000),format text NOT NULL CHECK(format IN ('plain','markdown')),attachment_ids uuid[] NOT NULL DEFAULT '{}',mention_ids uuid[] NOT NULL DEFAULT '{}',request_hash text NOT NULL,
 send_at timestamptz NOT NULL,auth_version integer NOT NULL,organization_policy_version integer NOT NULL,status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sent','cancelled','blocked')),error_code text,message_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,membership_id,client_id),UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,conversation_id,thread_id) REFERENCES messages(workspace_id,conversation_id,id),FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id)
);
CREATE INDEX scheduled_messages_due ON scheduled_messages(workspace_id,send_at,id) WHERE status='scheduled';
CREATE TABLE scheduled_message_files (
 workspace_id uuid NOT NULL,schedule_id uuid NOT NULL,file_id uuid NOT NULL,PRIMARY KEY(workspace_id,schedule_id,file_id),
 FOREIGN KEY(workspace_id,schedule_id) REFERENCES scheduled_messages(workspace_id,id),FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id)
);
CREATE TABLE group_history_proposals (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,conversation_id uuid NOT NULL,target_id uuid NOT NULL,requested_by uuid NOT NULL,base_version integer NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','expired')),voters uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),FOREIGN KEY(workspace_id,target_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,requested_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE group_history_votes (
 workspace_id uuid NOT NULL,proposal_id uuid NOT NULL,membership_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN ('approve','reject')),PRIMARY KEY(workspace_id,proposal_id,membership_id),FOREIGN KEY(workspace_id,proposal_id) REFERENCES group_history_proposals(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
DO $policies$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['conversation_membership_intervals','message_pins','saved_messages','thread_followers','message_drafts','personal_sidebars','scheduled_messages','scheduled_message_files','group_history_proposals','group_history_votes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['saved_messages','thread_followers','message_drafts','personal_sidebars','scheduled_messages'] LOOP
  EXECUTE format('CREATE POLICY personal_owner ON %I AS RESTRICTIVE TO ao_runtime USING(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid) WITH CHECK(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid)',name);
 END LOOP;
END
$policies$;
CREATE POLICY personal_owner ON scheduled_message_files AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM scheduled_messages s WHERE s.workspace_id=scheduled_message_files.workspace_id AND s.id=schedule_id));
CREATE POLICY pin_audience ON message_pins AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=message_pins.workspace_id AND m.id=message_id));
CREATE POLICY draft_audience ON message_drafts AS RESTRICTIVE FOR SELECT TO ao_runtime USING(message_visible_to(workspace_id,conversation_id,2147483647,thread_id,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY scheduled_audience ON scheduled_messages AS RESTRICTIVE FOR SELECT TO ao_runtime USING(message_visible_to(workspace_id,conversation_id,2147483647,thread_id,nullif(current_setting('ao.membership_id',true),'')::uuid) AND (message_id IS NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=scheduled_messages.workspace_id AND m.id=message_id)));
CREATE POLICY message_history ON outbox_events AS RESTRICTIVE FOR SELECT TO ao_runtime USING(event_type NOT LIKE 'message.%' OR EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=outbox_events.workspace_id AND m.id=resource_id));
CREATE POLICY consent_audience ON group_history_proposals AS RESTRICTIVE TO ao_runtime USING(nullif(current_setting('ao.membership_id',true),'')::uuid=ANY(voters)) WITH CHECK(nullif(current_setting('ao.membership_id',true),'')::uuid=ANY(voters));
CREATE POLICY consent_audience ON group_history_votes AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM group_history_proposals p WHERE p.workspace_id=group_history_votes.workspace_id AND p.id=proposal_id)) WITH CHECK(membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE INDEX saved_messages_page ON saved_messages(workspace_id,membership_id,created_at DESC,message_id DESC);
CREATE INDEX message_pins_page ON message_pins(workspace_id,conversation_id,created_at DESC,message_id DESC);
CREATE INDEX drafts_page ON message_drafts(workspace_id,membership_id,updated_at DESC,conversation_id,thread_id);
CREATE INDEX scheduled_messages_page ON scheduled_messages(workspace_id,membership_id,created_at DESC,id DESC);
CREATE INDEX consent_pending ON group_history_proposals(workspace_id,conversation_id,created_at DESC) WHERE status='pending';
CREATE UNIQUE INDEX consent_one_pending_target ON group_history_proposals(workspace_id,conversation_id,target_id,base_version) WHERE status='pending';
CREATE INDEX messages_author_page ON messages(workspace_id,author_id,client_id);
CREATE FUNCTION thread_following(tenant uuid,root uuid,member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT following FROM public.thread_followers WHERE workspace_id=tenant AND message_id=root AND membership_id=member AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
REVOKE ALL ON FUNCTION thread_following(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thread_following(uuid,uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION workspace_policy_version(tenant uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT o.version FROM public.organizations o JOIN public.workspaces w ON w.organization_id=o.id WHERE w.id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
REVOKE ALL ON FUNCTION workspace_policy_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_policy_version(uuid) TO ao_runtime,ao_worker;

CREATE INDEX conversations_discovery_page ON conversations(workspace_id,created_at DESC,id DESC) WHERE kind='channel';
CREATE INDEX memberships_page ON memberships(workspace_id,created_at DESC,id DESC);
CREATE INDEX agents_page ON agents(workspace_id,created_at DESC,id DESC);
CREATE INDEX knowledge_pages_page ON knowledge_pages(workspace_id,updated_at DESC,id DESC);
CREATE INDEX audit_events_page ON audit_events(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_runs_page ON agent_runs(workspace_id,created_at DESC,id DESC);
CREATE INDEX tool_invocations_page ON tool_invocations(workspace_id,created_at DESC,id DESC);
