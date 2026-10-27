CREATE TABLE migration_sources (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces, owner_id uuid NOT NULL,
 client_id uuid NOT NULL, name text NOT NULL, provider text NOT NULL CHECK(provider IN ('slack','teams','discord')),
 source_workspace_id text NOT NULL, mode text NOT NULL CHECK(mode IN ('import','inbound','bidirectional')),
 conflict_owner text NOT NULL CHECK(conflict_owner IN ('source','local','manual')),
 state text NOT NULL DEFAULT 'paused' CHECK(state IN ('paused','active','disconnected')),
 version integer NOT NULL DEFAULT 1, cursor text, source_complete boolean NOT NULL DEFAULT false,
 relay_secret text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,owner_id,client_id), UNIQUE(workspace_id,provider,source_workspace_id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE migration_channels (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL, external_id text NOT NULL, conversation_id uuid NOT NULL,
 visibility text NOT NULL CHECK(visibility IN ('public','private')), expansion_ack boolean NOT NULL,
 PRIMARY KEY(workspace_id,source_id,external_id), UNIQUE(workspace_id,source_id,conversation_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE migration_identities (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL, external_id text NOT NULL, name text NOT NULL, membership_id uuid,
 PRIMARY KEY(workspace_id,source_id,external_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE migration_batches (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, source_id uuid NOT NULL, client_id uuid NOT NULL,
 fingerprint text NOT NULL, cursor text, complete boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,source_id,client_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id)
);
CREATE TABLE migration_records (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, source_id uuid NOT NULL, batch_id uuid NOT NULL,
 external_id text NOT NULL, external_channel_id text NOT NULL, revision text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','conflict','omitted')),
 reason text, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,source_id,external_channel_id,external_id,revision),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES migration_batches(workspace_id,id)
);
CREATE TABLE migration_origins (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL, external_channel_id text NOT NULL, external_id text NOT NULL,
 conversation_id uuid NOT NULL, message_id uuid NOT NULL, source_revision text NOT NULL, local_version integer NOT NULL,
 PRIMARY KEY(workspace_id,source_id,external_channel_id,external_id), UNIQUE(workspace_id,message_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE TABLE migration_deliveries (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, source_id uuid NOT NULL, conversation_id uuid NOT NULL,
 message_id uuid NOT NULL, message_version integer NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','uncertain','cancelled')),
 lease_token uuid, lease_until timestamptz, external_id text, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,message_id,message_version),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
ALTER TABLE messages ADD COLUMN source_attribution jsonb;
CREATE INDEX migration_pending ON migration_records(workspace_id,source_id,created_at,id) WHERE state='pending';
CREATE INDEX migration_delivery_pending ON migration_deliveries(workspace_id,source_id,created_at) WHERE state IN ('pending','leased');
DO $body$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['migration_sources','migration_channels','migration_identities','migration_batches','migration_records','migration_origins','migration_deliveries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY importer_authority ON %I AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=%I.workspace_id AND m.id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid AND m.status=''active'' AND m.access_type=''member'' AND m.role IN (''owner'',''admin'') AND coalesce((m.permissions->>''workspace.manage'')::boolean,true)))',t,t);
 END LOOP;
END
$body$;
CREATE FUNCTION guard_imported_message() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND NEW.source_attribution IS NOT NULL THEN NEW.source_attribution=jsonb_set(jsonb_set(NEW.source_attribution,'{reactions}','[]'::jsonb),'{files}','[]'::jsonb); END IF;
 IF OLD.source_attribution IS NOT NULL AND EXISTS(SELECT 1 FROM public.migration_sources s WHERE s.workspace_id=OLD.workspace_id AND s.id=(OLD.source_attribution->>'sourceId')::uuid AND s.conflict_owner='source') AND NEW.deleted_at IS NULL AND (NEW.body,NEW.format) IS DISTINCT FROM (OLD.body,OLD.format)
 AND coalesce(current_setting('ao.import_source',true),'')<>coalesce(OLD.source_attribution->>'sourceId','') THEN
  RAISE EXCEPTION 'Imported messages require explicit conflict resolution' USING ERRCODE='AOM11';
 END IF;
 RETURN NEW;
END
$body$;
CREATE TRIGGER imported_message_guard BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION guard_imported_message();
ALTER TABLE migration_sources ADD COLUMN owner_auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE migration_sources ADD COLUMN owner_policy_version integer NOT NULL DEFAULT 1;
CREATE FUNCTION migration_owner_current(tenant uuid,member uuid,auth integer,policy integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT EXISTS(SELECT 1 FROM public.memberships m JOIN public.accounts a ON a.id=m.account_id JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.organizations o ON o.id=w.organization_id JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=a.id
 WHERE m.workspace_id=tenant AND m.id=member AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND m.status='active' AND m.access_type='member' AND m.role IN ('owner','admin') AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND a.auth_version=auth AND o.version=policy AND om.status='active' AND coalesce((m.permissions->>'workspace.manage')::boolean,true) AND coalesce((m.permissions->>'messages.read')::boolean,true) AND coalesce((m.permissions->>'messages.write')::boolean,true) AND (cardinality(o.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(o.allowed_domains)))
$body$;
REVOKE ALL ON FUNCTION migration_owner_current(uuid,uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION migration_owner_current(uuid,uuid,integer,integer) TO ao_runtime,ao_worker;
ALTER TABLE migration_deliveries DROP CONSTRAINT migration_deliveries_source_id_message_id_message_version_key;
ALTER TABLE migration_deliveries ADD COLUMN event_id bigint REFERENCES outbox_events(id);
ALTER TABLE migration_deliveries ADD COLUMN event_type text;
ALTER TABLE migration_deliveries ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE migration_deliveries ADD COLUMN claim_request_id uuid;
CREATE UNIQUE INDEX migration_delivery_event ON migration_deliveries(source_id,event_id);
CREATE UNIQUE INDEX migration_delivery_claim ON migration_deliveries(source_id,claim_request_id) WHERE claim_request_id IS NOT NULL;
ALTER TABLE migration_records ADD COLUMN payload_hash text NOT NULL DEFAULT '';
CREATE FUNCTION queue_migration_delivery(tenant uuid,event bigint) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 INSERT INTO public.migration_deliveries(id,workspace_id,source_id,conversation_id,message_id,message_version,event_id,event_type)
 SELECT gen_random_uuid(),m.workspace_id,s.id,m.conversation_id,m.id,m.version,e.id,e.event_type FROM public.outbox_events e
 JOIN public.messages m ON m.workspace_id=e.workspace_id AND m.id=e.resource_id
 JOIN public.migration_channels mc ON mc.workspace_id=m.workspace_id AND mc.conversation_id=m.conversation_id
 JOIN public.migration_sources s ON s.workspace_id=mc.workspace_id AND s.id=mc.source_id
 WHERE e.workspace_id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND e.id=event
 AND e.event_type IN ('message.created','message.edited','message.deleted','message.reaction_changed')
 AND s.state='active' AND s.mode='bidirectional' AND nullif(current_setting('ao.import_source',true),'') IS NULL
 AND (m.source_attribution IS NULL OR m.source_attribution->>'sourceId'=s.id::text)
 ON CONFLICT DO NOTHING
$body$;
REVOKE ALL ON FUNCTION queue_migration_delivery(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_migration_delivery(uuid,bigint) TO ao_runtime,ao_worker;
CREATE FUNCTION scrub_imported_tombstone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
 UPDATE public.migration_records r SET payload=jsonb_set(jsonb_set(jsonb_set(payload,'{body}','""'::jsonb),'{files}','[]'::jsonb),'{reactions}','[]'::jsonb)
 FROM public.migration_origins o WHERE o.workspace_id=NEW.workspace_id AND o.message_id=NEW.id AND r.workspace_id=o.workspace_id AND r.source_id=o.source_id AND r.external_channel_id=o.external_channel_id AND r.external_id=o.external_id;
 END IF;
 RETURN NEW;
END
$body$;
CREATE TRIGGER imported_tombstone_cleanup AFTER UPDATE OF deleted_at ON messages FOR EACH ROW EXECUTE FUNCTION scrub_imported_tombstone();
GRANT SELECT(id) ON outbox_events TO ao_identity;
CREATE POLICY identity_outbox_receipt ON outbox_events FOR SELECT TO ao_identity USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
GRANT EXECUTE ON FUNCTION queue_migration_delivery(uuid,bigint) TO ao_identity;
CREATE TABLE migration_file_mappings (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL, external_id text NOT NULL,
 conversation_id uuid NOT NULL, file_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,source_id,external_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES migration_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id)
);
ALTER TABLE migration_file_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_file_mappings FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON migration_file_mappings TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON migration_file_mappings TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY importer_authority ON migration_file_mappings AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=migration_file_mappings.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.access_type='member' AND m.role IN ('owner','admin') AND coalesce((m.permissions->>'workspace.manage')::boolean,true)));
ALTER TABLE migration_deliveries ADD CONSTRAINT migration_delivery_tenant UNIQUE(workspace_id,id);
CREATE TABLE migration_reconciliations (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces,delivery_id uuid NOT NULL,
 actor_id uuid NOT NULL,evidence text NOT NULL,outcome text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,delivery_id) REFERENCES migration_deliveries(workspace_id,id)
);
ALTER TABLE migration_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_reconciliations FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON migration_reconciliations TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON migration_reconciliations TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY importer_authority ON migration_reconciliations AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=migration_reconciliations.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.role IN ('owner','admin') AND m.access_type='member'));
