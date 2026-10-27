ALTER TABLE connection_events ADD COLUMN payload_hash text NOT NULL DEFAULT '';
CREATE TABLE connection_webhooks (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, encrypted_incoming text NOT NULL, encrypted_outgoing text NOT NULL,
 endpoint text, email_channel_id uuid, email_actor_id uuid, email_senders text[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connection_id), FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
 FOREIGN KEY(workspace_id,email_channel_id) REFERENCES conversations(workspace_id,id), FOREIGN KEY(workspace_id,email_actor_id) REFERENCES memberships(workspace_id,id),
 CHECK((email_channel_id IS NULL)=(email_actor_id IS NULL))
);
ALTER TABLE connection_events ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days';
CREATE TABLE connection_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, connection_id uuid NOT NULL,event_id uuid NOT NULL,
 webhook_version integer NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','completed','dead')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease uuid,lease_until timestamptz,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id),UNIQUE(workspace_id,event_id,webhook_version),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),FOREIGN KEY(workspace_id,event_id) REFERENCES connection_events(workspace_id,id) ON DELETE CASCADE
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['connection_webhooks','connection_deliveries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 EXECUTE format('CREATE POLICY owner_boundary ON %I AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting(''ao.membership_id'',true),'''')::uuid,true)) WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting(''ao.membership_id'',true),'''')::uuid,true))',name);
 END LOOP;
END $$;
CREATE INDEX connection_deliveries_due ON connection_deliveries(workspace_id,available_at) WHERE state IN ('pending','sending');
CREATE FUNCTION notify_connection_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.state='completed' AND OLD.state<>'completed' THEN
 INSERT INTO public.connection_deliveries(workspace_id,connection_id,event_id,webhook_version)
 SELECT NEW.workspace_id,NEW.connection_id,NEW.id,w.version FROM public.connection_webhooks w WHERE w.workspace_id=NEW.workspace_id AND w.connection_id=NEW.connection_id AND w.enabled AND w.endpoint IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER connection_event_completed AFTER UPDATE ON connection_events FOR EACH ROW EXECUTE FUNCTION notify_connection_event();
REVOKE ALL ON FUNCTION notify_connection_event() FROM PUBLIC;
