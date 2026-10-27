ALTER TABLE agents DROP CONSTRAINT agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check CHECK(status IN ('active','paused','archived'));
ALTER TABLE agents ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE agents ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE agents ADD COLUMN last_seen_at timestamptz;
CREATE TABLE agent_revisions (
 workspace_id uuid NOT NULL, agent_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 configuration jsonb NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,agent_id,revision),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
INSERT INTO agent_revisions(workspace_id,agent_id,revision,configuration,created_by)
 SELECT workspace_id,id,1,jsonb_build_object('instructions',instructions,'model','operator_default','tools',jsonb_build_array('create_task','save_knowledge'),'skills','[]'::jsonb,'activation','mentions','conversationIds','[]'::jsonb,'limits',jsonb_build_object('maxSeconds',300,'maxInputTokens',60000,'maxOutputTokens',8000,'maxTools',4,'reservationMicros',500000)),owner_id FROM agents;
CREATE FUNCTION immutable_agent_revision() RETURNS trigger LANGUAGE plpgsql AS $body$
 BEGIN RAISE EXCEPTION 'Agent revisions are immutable' USING ERRCODE='23514'; END
$body$;
CREATE TRIGGER immutable_agent_revision BEFORE UPDATE OR DELETE ON agent_revisions FOR EACH ROW EXECUTE FUNCTION immutable_agent_revision();
ALTER TABLE agents ADD CONSTRAINT agent_revision_fk FOREIGN KEY(workspace_id,id,revision) REFERENCES agent_revisions(workspace_id,agent_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE agent_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes text[] NOT NULL,
 conversation_ids uuid[] NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_by uuid, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),
 CHECK(expires_at>created_at), CHECK(cardinality(scopes)>0)
);
INSERT INTO agent_credentials(workspace_id,agent_id,name,token_hash,scopes,expires_at,created_by)
 SELECT workspace_id,id,'Initial connection',key_hash,ARRAY['inbox.read','inbox.work','messages.read','messages.write','tasks.read','tasks.write','knowledge.read','files.read','search.read'],now()+interval '30 days',credential_issuer_id FROM agents WHERE runtime='external' AND key_hash IS NOT NULL;
CREATE FUNCTION revoke_agent_connections() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 BEGIN
 IF NEW.key_hash IS DISTINCT FROM OLD.key_hash OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.status='archived' THEN
  UPDATE public.agent_credentials SET revoked_at=now() WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.id AND revoked_at IS NULL;
 END IF;
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.status='archived' THEN
  UPDATE public.agent_webhooks SET enabled=false,version=version+1 WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.id;
 END IF;
 RETURN NEW;
 END
$body$;
CREATE TRIGGER revoke_agent_connections AFTER UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION revoke_agent_connections();
ALTER TABLE agent_inbox DROP CONSTRAINT agent_inbox_state_check;
ALTER TABLE agent_inbox ADD CONSTRAINT agent_inbox_state_check CHECK(state IN ('pending','accepted','leased','completed','dead','expired'));
ALTER TABLE agent_inbox ADD COLUMN lease_token uuid;
ALTER TABLE agent_inbox ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE agent_inbox ADD COLUMN fence integer NOT NULL DEFAULT 0;
ALTER TABLE agent_inbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE agent_inbox ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_inbox ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days';
ALTER TABLE agent_inbox ADD COLUMN completed_at timestamptz;
ALTER TABLE agent_inbox ADD COLUMN summary text;
ALTER TABLE agent_inbox ADD COLUMN credential_id uuid;
UPDATE agent_inbox i SET state='dead',summary='Legacy receipt acknowledged; completion was not confirmed. Review before redelivery.' FROM agents a WHERE a.workspace_id=i.workspace_id AND a.id=i.agent_id AND a.runtime='external' AND i.state='accepted';
ALTER TABLE agent_inbox ADD CONSTRAINT inbox_workspace_id_unique UNIQUE(workspace_id,id);
ALTER TABLE agent_inbox ADD CONSTRAINT inbox_credential_fk FOREIGN KEY(workspace_id,credential_id) REFERENCES agent_credentials(workspace_id,id);
CREATE INDEX inbox_lease_due ON agent_inbox(workspace_id,state,available_at,created_at);
CREATE TABLE agent_webhooks (
 workspace_id uuid NOT NULL, agent_id uuid NOT NULL, url text NOT NULL, encrypted_secret text NOT NULL,
 version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,agent_id), FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id)
);
CREATE TABLE agent_wakeups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 inbox_id uuid NOT NULL, webhook_version integer NOT NULL,generation integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_expires_at timestamptz,
 delivered_at timestamptz, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id),
 FOREIGN KEY(workspace_id,inbox_id) REFERENCES agent_inbox(workspace_id,id), UNIQUE(workspace_id,inbox_id,webhook_version,generation)
);
CREATE FUNCTION agent_inbox_wakeup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 BEGIN
 IF NEW.state<>'pending' OR TG_OP='UPDATE' AND OLD.state='pending' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.agents WHERE workspace_id=NEW.workspace_id AND id=NEW.agent_id AND runtime='managed') THEN
  INSERT INTO public.execution_policies(workspace_id,needs_work) VALUES(NEW.workspace_id,true) ON CONFLICT(workspace_id) DO UPDATE SET needs_work=true;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agents a JOIN public.agent_revisions v ON v.workspace_id=a.workspace_id AND v.agent_id=a.id AND v.revision=a.revision JOIN public.messages m ON m.workspace_id=NEW.workspace_id AND m.id=NEW.message_id WHERE a.workspace_id=NEW.workspace_id AND a.id=NEW.agent_id AND a.status='active' AND v.configuration->>'activation'='mentions' AND (jsonb_array_length(v.configuration->'conversationIds')=0 OR v.configuration->'conversationIds' ? m.conversation_id::text)) THEN RETURN NEW; END IF;
 INSERT INTO public.outbox_events(workspace_id,event_type,resource_id,conversation_id,audience_membership_id)
 SELECT NEW.workspace_id,'agent.inbox_ready',NEW.id,m.conversation_id,a.membership_id FROM public.agents a JOIN public.messages m ON m.workspace_id=NEW.workspace_id AND m.id=NEW.message_id WHERE a.id=NEW.agent_id AND a.workspace_id=NEW.workspace_id;
 INSERT INTO public.agent_wakeups(workspace_id,agent_id,inbox_id,webhook_version,generation)
 SELECT NEW.workspace_id,NEW.agent_id,NEW.id,w.version,NEW.fence FROM public.agent_webhooks w WHERE w.workspace_id=NEW.workspace_id AND w.agent_id=NEW.agent_id AND w.enabled ON CONFLICT DO NOTHING;
 RETURN NEW;
 END
$body$;
CREATE TRIGGER agent_inbox_wakeup AFTER INSERT OR UPDATE OF state ON agent_inbox FOR EACH ROW EXECUTE FUNCTION agent_inbox_wakeup();
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['agent_revisions','agent_credentials','agent_webhooks','agent_wakeups'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END
$body$;
GRANT SELECT,UPDATE ON agent_credentials TO ao_identity;
CREATE POLICY credential_identity ON agent_credentials TO ao_identity USING(true) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE FUNCTION agent_credential_allows(conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT nullif(current_setting('ao.agent_credential_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM public.agent_credentials c JOIN public.agents a ON a.workspace_id=c.workspace_id AND a.id=c.agent_id
  WHERE c.workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid AND c.id=nullif(current_setting('ao.agent_credential_id',true),'')::uuid
  AND a.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND a.status='active' AND c.revoked_at IS NULL AND c.expires_at>now()
  AND (cardinality(c.conversation_ids)=0 OR conversation=ANY(c.conversation_ids)))
$body$;
REVOKE ALL ON FUNCTION agent_credential_allows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_credential_allows(uuid) TO ao_runtime,ao_worker;
CREATE POLICY credential_audience ON conversations AS RESTRICTIVE TO ao_runtime USING(agent_credential_allows(id)) WITH CHECK(agent_credential_allows(id));
DO $body$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['messages','tasks','knowledge_pages','files','projects','agent_runs','outbox_events','audit_events'] LOOP
 EXECUTE format('CREATE POLICY credential_audience ON %I AS RESTRICTIVE TO ao_runtime USING(agent_credential_allows(conversation_id)) WITH CHECK(agent_credential_allows(conversation_id))',name);
 END LOOP;
END
$body$;
CREATE POLICY inbox_owner ON agent_inbox AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM agents a WHERE a.workspace_id=agent_inbox.workspace_id AND a.id=agent_id AND (nullif(current_setting('ao.agent_credential_id',true),'') IS NULL OR a.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid)) AND EXISTS(SELECT 1 FROM messages m WHERE m.workspace_id=agent_inbox.workspace_id AND m.id=message_id AND m.deleted_at IS NULL));
