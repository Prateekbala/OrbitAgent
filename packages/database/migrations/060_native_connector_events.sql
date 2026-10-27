CREATE TABLE connection_native_hooks (
 workspace_id uuid NOT NULL,connection_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN ('github','gitlab','linear','stripe')),
 encrypted_secret text NOT NULL,version integer NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connection_id),FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE connection_native_hooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_native_hooks FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON connection_native_hooks TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON connection_native_hooks TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY native_hook_owner ON connection_native_hooks AS RESTRICTIVE TO ao_runtime USING(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true)) WITH CHECK(connection_access(workspace_id,connection_id,nullif(current_setting('ao.membership_id',true),'')::uuid,true));
ALTER TABLE connection_events ADD COLUMN protocol text NOT NULL DEFAULT 'orbit-bridge-v1' CHECK(protocol IN ('orbit-bridge-v1','native'));
ALTER TABLE connection_events ADD COLUMN native_hook_version integer;
ALTER TABLE connection_events ADD CONSTRAINT native_event_generation CHECK((protocol='native')=(native_hook_version IS NOT NULL));
CREATE UNIQUE INDEX native_payload_once ON connection_events(workspace_id,connection_id,native_hook_version,payload_hash) WHERE protocol='native';
CREATE FUNCTION revoke_native_hook() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 UPDATE public.connection_native_hooks SET enabled=false,encrypted_secret='',version=version+1 WHERE workspace_id=NEW.workspace_id AND connection_id=NEW.id;
 RETURN NULL;END $$;
CREATE TRIGGER revoke_native_hook AFTER UPDATE OF state,version,owner_id ON connections FOR EACH ROW WHEN((NEW.state,NEW.version,NEW.owner_id) IS DISTINCT FROM (OLD.state,OLD.version,OLD.owner_id)) EXECUTE FUNCTION revoke_native_hook();
REVOKE ALL ON FUNCTION revoke_native_hook() FROM PUBLIC;
