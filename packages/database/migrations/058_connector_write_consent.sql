ALTER TABLE connections ADD COLUMN write_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE connection_oauth_states ADD CONSTRAINT oauth_reconnect_connection FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION invalidate_retrieval_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid; BEGIN
 IF TG_TABLE_NAME='connections' AND TG_OP='INSERT' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='connections' AND TG_OP='UPDATE' THEN
  IF (NEW.state,NEW.owner_id,NEW.audience,NEW.version,NEW.write_enabled) IS NOT DISTINCT FROM (OLD.state,OLD.owner_id,OLD.audience,OLD.version,OLD.write_enabled) THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='memberships' AND TG_OP='UPDATE' THEN
  IF NEW.status=OLD.status AND NEW.access_type=OLD.access_type AND NEW.permissions=OLD.permissions AND
   array_position(ARRAY['member','admin','owner'],NEW.role)>=array_position(ARRAY['member','admin','owner'],OLD.role) THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='workspaces' THEN tenant:=NEW.id;
 ELSIF TG_OP='DELETE' THEN tenant:=OLD.workspace_id; ELSE tenant:=NEW.workspace_id;END IF;
 INSERT INTO public.retrieval_authority(workspace_id) VALUES(tenant) ON CONFLICT(workspace_id) DO UPDATE SET epoch=public.retrieval_authority.epoch+1;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=tenant;
 INSERT INTO public.outbox_events(workspace_id,event_type,resource_id) VALUES(tenant,'retrieval.invalidated',tenant);
 RETURN NULL; END $$;
DROP TRIGGER retrieval_revocation ON connections;
CREATE TRIGGER retrieval_revocation AFTER INSERT OR DELETE OR UPDATE OF state,owner_id,audience,version,write_enabled ON connections FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
