CREATE TABLE calendar_connections (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,membership_id uuid NOT NULL,provider text NOT NULL DEFAULT 'google' CHECK(provider='google'),calendar_id text NOT NULL DEFAULT 'primary',credentials text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','needs_auth','disconnected')),version integer NOT NULL DEFAULT 1,auth_version integer NOT NULL,policy_version integer NOT NULL,sync_token text,page_token text,next_sync_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_expires_at timestamptz,last_synced_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,membership_id,provider),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE calendar_exports (
 workspace_id uuid NOT NULL,connection_id uuid NOT NULL,task_id uuid NOT NULL,event_id text NOT NULL,etag text,task_version integer NOT NULL DEFAULT 0 CHECK(task_version>=0),suppressed boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','conflict','removed')),remote jsonb,pending_payload jsonb,pending_task_version integer,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,connection_id,task_id),UNIQUE(workspace_id,connection_id,event_id),FOREIGN KEY(workspace_id,connection_id) REFERENCES calendar_connections(workspace_id,id),FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id)
);
CREATE TABLE calendar_oauth_states (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,membership_id uuid NOT NULL,state_hash text NOT NULL UNIQUE,session_hash text NOT NULL,verifier text NOT NULL,auth_version integer NOT NULL,policy_version integer NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE calendar_feeds (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,membership_id uuid NOT NULL,token_hash text NOT NULL UNIQUE,auth_version integer NOT NULL,policy_version integer NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['calendar_connections','calendar_exports','calendar_oauth_states','calendar_feeds'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['calendar_connections','calendar_oauth_states','calendar_feeds'] LOOP
  EXECUTE format('CREATE POLICY personal_owner ON %I AS RESTRICTIVE TO ao_runtime USING(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid) WITH CHECK(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE POLICY export_owner ON calendar_exports AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM calendar_connections c WHERE c.workspace_id=calendar_exports.workspace_id AND c.id=connection_id));
CREATE INDEX calendar_ready ON calendar_connections(workspace_id,next_sync_at,id) WHERE status='active';
CREATE INDEX calendar_export_state ON calendar_exports(workspace_id,connection_id,status,task_id);
CREATE FUNCTION calendar_feed_identity(hash text) RETURNS TABLE(workspace_id uuid,membership_id uuid,auth_version integer,policy_version integer,expires_at timestamptz) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.workspace_id,f.membership_id,f.auth_version,f.policy_version,f.expires_at FROM public.calendar_feeds f WHERE f.token_hash=hash AND f.revoked_at IS NULL AND f.expires_at>now()
$$;
REVOKE ALL ON FUNCTION calendar_feed_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_feed_identity(text) TO ao_identity;
