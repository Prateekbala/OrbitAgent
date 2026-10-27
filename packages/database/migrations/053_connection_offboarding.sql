CREATE FUNCTION offboard_connected_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE revoke_owner boolean;BEGIN
 revoke_owner:=NEW.status<>'active' OR NEW.access_type<>'member' OR NEW.permissions->>'execution.manage'='false' OR NEW.permissions->>'knowledge.read'='false';
 IF NEW.status<>'active' OR NEW.access_type<>'member' THEN
  UPDATE public.connection_grants SET revoked_at=now() WHERE workspace_id=NEW.workspace_id AND member_id=NEW.id AND revoked_at IS NULL;
 END IF;
 IF revoke_owner THEN
  UPDATE public.connections SET state='revoked',version=version+1,last_error_code='OWNER_AUTHORITY_REVOKED',updated_at=now() WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id AND state<>'revoked';
  DELETE FROM public.connection_secrets s WHERE s.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=s.workspace_id AND c.id=s.connection_id AND c.owner_id=NEW.id);
  DELETE FROM public.connection_oauth_states WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id;
  UPDATE public.connection_webhooks w SET enabled=false,encrypted_incoming='',encrypted_outgoing='',version=version+1 WHERE w.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=w.workspace_id AND c.id=w.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_resources r SET deleted_at=now(),body='',title='Removed resource',version=version+1 WHERE r.workspace_id=NEW.workspace_id AND r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=r.workspace_id AND c.id=r.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_events e SET state='dead',error_code='OWNER_AUTHORITY_REVOKED',payload='{}',lease=NULL,lease_until=NULL WHERE e.workspace_id=NEW.workspace_id AND e.state IN ('pending','leased') AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=e.workspace_id AND c.id=e.connection_id AND c.owner_id=NEW.id);
  UPDATE public.connection_deliveries d SET state='dead',error_code='OWNER_AUTHORITY_REVOKED',lease=NULL,lease_until=NULL WHERE d.workspace_id=NEW.workspace_id AND d.state IN ('pending','sending') AND EXISTS(SELECT 1 FROM public.connections c WHERE c.workspace_id=d.workspace_id AND c.id=d.connection_id AND c.owner_id=NEW.id);
 END IF;
 IF NEW.status<>'active' OR NEW.access_type<>'member' THEN DELETE FROM public.agent_memories WHERE workspace_id=NEW.workspace_id AND owner_id=NEW.id;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER connected_offboarding AFTER UPDATE OF status,access_type,permissions ON memberships FOR EACH ROW EXECUTE FUNCTION offboard_connected_authority();
REVOKE ALL ON FUNCTION offboard_connected_authority() FROM PUBLIC;
