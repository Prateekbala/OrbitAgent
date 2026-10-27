CREATE TABLE memory_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,source_memory_id uuid NOT NULL,source_version integer NOT NULL,
 published_memory_id uuid NOT NULL,approved_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 body_hash text NOT NULL,target_conversation_id uuid,sources jsonb NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,source_memory_id) REFERENCES agent_memories(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,published_memory_id) REFERENCES agent_memories(workspace_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,approved_by) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE agent_memories ADD COLUMN release_id uuid;
ALTER TABLE agent_memories ADD CONSTRAINT memory_release_reference FOREIGN KEY(workspace_id,release_id) REFERENCES memory_releases(workspace_id,id) ON DELETE SET NULL (release_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memory_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_releases FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON memory_releases TO ao_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON memory_releases TO ao_worker;
CREATE POLICY tenant_boundary ON memory_releases TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY release_owner ON memory_releases AS RESTRICTIVE TO ao_runtime USING(approved_by=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(approved_by=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE FUNCTION retrieval_provenance_current(tenant uuid,kind text,target uuid,revision integer,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE refs jsonb; ref jsonb; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR depth>16 OR public.retrieval_source_version(tenant,kind,target) IS DISTINCT FROM revision THEN RETURN false;END IF;
 IF kind='memory' THEN SELECT sources INTO refs FROM public.agent_memories WHERE workspace_id=tenant AND id=target;
 ELSIF kind='knowledge' THEN SELECT coalesce(jsonb_agg(jsonb_build_object('kind',CASE WHEN source_page_id IS NULL THEN 'message' ELSE 'knowledge' END,'id',coalesce(source_page_id,source_message_id),'version',source_version)),'[]'::jsonb) INTO refs FROM public.knowledge_sources WHERE workspace_id=tenant AND page_id=target;
 ELSE RETURN true;END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
 IF NOT public.retrieval_provenance_current(tenant,ref->>'kind',(ref->>'id')::uuid,(ref->>'version')::integer,depth+1) THEN RETURN false;END IF;END LOOP;RETURN true;
END $$;
CREATE FUNCTION retrieval_source_owned(tenant uuid,kind text,target uuid,member uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner uuid;refs jsonb;ref jsonb;BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR depth>16 THEN RETURN false;END IF;
 CASE kind
 WHEN 'message' THEN SELECT author_id INTO owner FROM public.messages WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL;
 WHEN 'task' THEN SELECT created_by INTO owner FROM public.tasks WHERE workspace_id=tenant AND id=target;
 WHEN 'knowledge' THEN
  SELECT owner_id INTO owner FROM public.knowledge_metadata WHERE workspace_id=tenant AND page_id=target;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',CASE WHEN source_page_id IS NULL THEN 'message' ELSE 'knowledge' END,'id',coalesce(source_page_id,source_message_id))),'[]'::jsonb) INTO refs FROM public.knowledge_sources WHERE workspace_id=tenant AND page_id=target;
 WHEN 'file' THEN SELECT uploader_id INTO owner FROM public.files WHERE workspace_id=tenant AND id=target;
 WHEN 'document' THEN SELECT c.owner_id INTO owner FROM public.connection_resources r JOIN public.connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id WHERE r.workspace_id=tenant AND r.id=target;
 WHEN 'transcript' THEN SELECT owner_id INTO owner FROM public.retained_transcripts WHERE workspace_id=tenant AND id=target;
 WHEN 'memory' THEN SELECT owner_id,sources INTO owner,refs FROM public.agent_memories WHERE workspace_id=tenant AND id=target;
 ELSE RETURN false;END CASE;
 IF owner IS DISTINCT FROM member THEN RETURN false;END IF;
 IF refs IS NOT NULL THEN FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
 IF NOT public.retrieval_source_owned(tenant,ref->>'kind',(ref->>'id')::uuid,member,depth+1) THEN RETURN false;END IF;END LOOP;END IF;
 RETURN true;END $$;
CREATE FUNCTION memory_release_valid(tenant uuid,target uuid,release uuid,body text,conversation uuid,refs jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.memory_releases r JOIN public.memberships m ON m.workspace_id=r.workspace_id AND m.id=r.approved_by
 WHERE r.workspace_id=tenant AND r.id=release AND r.published_memory_id=target AND r.revoked_at IS NULL AND r.target_conversation_id IS NOT DISTINCT FROM conversation
 AND r.body_hash=encode(sha256(convert_to(body,'UTF8')),'hex') AND r.sources=refs AND m.status='active' AND m.kind='human' AND m.access_type='member'
 AND public.retrieval_principal_current(tenant,m.id) AND coalesce((m.permissions->>'knowledge.write')::boolean,true)
 AND public.retrieval_provenance_current(tenant,'memory',r.source_memory_id,r.source_version))
$$;
REVOKE ALL ON FUNCTION retrieval_provenance_current(uuid,text,uuid,integer,integer),retrieval_source_owned(uuid,text,uuid,uuid,integer),memory_release_valid(uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retrieval_provenance_current(uuid,text,uuid,integer,integer),retrieval_source_owned(uuid,text,uuid,uuid,integer),memory_release_valid(uuid,uuid,uuid,text,uuid,jsonb) TO ao_runtime,ao_worker;
CREATE FUNCTION protect_memory_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.source_memory_id,NEW.source_version,NEW.published_memory_id,NEW.approved_by,NEW.reason,NEW.body_hash,NEW.target_conversation_id,NEW.sources,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.source_memory_id,OLD.source_version,OLD.published_memory_id,OLD.approved_by,OLD.reason,OLD.body_hash,OLD.target_conversation_id,OLD.sources,OLD.created_at) OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Release evidence is immutable; only revocation is allowed' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER protect_memory_release BEFORE UPDATE ON memory_releases FOR EACH ROW EXECUTE FUNCTION protect_memory_release();
REVOKE ALL ON FUNCTION protect_memory_release() FROM PUBLIC;
CREATE OR REPLACE FUNCTION retrieval_source_visible(tenant uuid,kind text,target uuid,member uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean; permission text; principal record; memory record; ref jsonb; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR depth>16 THEN RETURN false;END IF;
 SELECT * INTO principal FROM public.memberships WHERE workspace_id=tenant AND id=member AND status='active';
 IF principal.id IS NULL OR NOT public.retrieval_principal_current(tenant,member) THEN RETURN false;END IF;
 permission:=CASE kind WHEN 'message' THEN 'messages.read' WHEN 'task' THEN 'tasks.read' WHEN 'file' THEN 'files.read' ELSE 'knowledge.read' END;
 IF principal.permissions->>permission='false' OR principal.access_type='service' AND NOT coalesce((principal.permissions->>permission)::boolean,false) OR principal.access_type='guest' AND kind IN ('document','memory','transcript') THEN RETURN false;END IF;
 CASE kind
 WHEN 'message' THEN SELECT public.message_visible_to(tenant,m.conversation_id,m.sequence,m.thread_id,member) AND public.agent_credential_allows(m.conversation_id) INTO allowed FROM public.messages m WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL;
 WHEN 'knowledge' THEN SELECT public.resource_visible_to(tenant,p.conversation_id,p.created_at,member) AND public.agent_credential_allows(p.conversation_id) AND public.knowledge_lineage_visible(tenant,p.id,member,NULL,false) INTO allowed FROM public.knowledge_pages p JOIN public.knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=tenant AND p.id=target AND m.state='active' AND NOT m.blocked AND m.superseded_by IS NULL;
 WHEN 'task' THEN SELECT public.resource_visible_to(tenant,t.conversation_id,t.created_at,member) AND public.agent_credential_allows(t.conversation_id) INTO allowed FROM public.tasks t WHERE workspace_id=tenant AND id=target;
 WHEN 'file' THEN SELECT public.agent_credential_allows(f.conversation_id) AND CASE WHEN f.task_id IS NOT NULL THEN EXISTS(SELECT 1 FROM public.tasks t WHERE t.workspace_id=tenant AND t.id=f.task_id AND public.resource_visible_to(tenant,t.conversation_id,t.created_at,member)) ELSE EXISTS(SELECT 1 FROM public.message_attachments a JOIN public.messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id WHERE a.workspace_id=tenant AND a.file_id=f.id AND m.deleted_at IS NULL AND public.message_visible_to(tenant,m.conversation_id,m.sequence,m.thread_id,member)) END INTO allowed FROM public.files f WHERE f.workspace_id=tenant AND f.id=target AND f.status='attached' AND f.scan_status IN ('clean','development_only');
 WHEN 'document' THEN SELECT public.connection_resource_access(tenant,target,member) AND public.agent_credential_allows(r.conversation_id) INTO allowed FROM public.connection_resources r WHERE r.workspace_id=tenant AND r.id=target;
 WHEN 'transcript' THEN SELECT public.resource_visible_to(tenant,t.conversation_id,t.created_at,member) AND public.agent_credential_allows(t.conversation_id) INTO allowed FROM public.retained_transcripts t WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL AND retained_until>now();
 WHEN 'memory' THEN
  SELECT m.*,a.membership_id agent_member INTO memory FROM public.agent_memories m JOIN public.agents a ON a.workspace_id=m.workspace_id AND a.id=m.agent_id WHERE m.workspace_id=tenant AND m.id=target AND m.deleted_at IS NULL AND m.expires_at>now();
  IF memory.id IS NULL OR memory.boundary='private' AND member NOT IN (memory.owner_id,memory.agent_member) OR NOT public.resource_visible_to(tenant,memory.conversation_id,memory.created_at,member) OR NOT public.agent_credential_allows(memory.conversation_id) THEN RETURN false;END IF;
  IF memory.release_id IS NOT NULL AND public.memory_release_valid(tenant,target,memory.release_id,memory.body,memory.conversation_id,memory.sources) THEN RETURN true;END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(memory.sources) LOOP
   IF NOT public.retrieval_source_visible(tenant,ref->>'kind',(ref->>'id')::uuid,member,depth+1) OR public.retrieval_source_version(tenant,ref->>'kind',(ref->>'id')::uuid) IS DISTINCT FROM (ref->>'version')::integer THEN RETURN false;END IF;
  END LOOP; RETURN true;
 ELSE RETURN false;END CASE;
 RETURN coalesce(allowed,false); END $$;
DROP POLICY memory_audience ON agent_memories;
CREATE POLICY memory_audience ON agent_memories AS RESTRICTIVE FOR SELECT TO ao_runtime USING(deleted_at IS NULL AND expires_at>now() AND (boundary<>'private' OR owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM agents a WHERE a.workspace_id=agent_memories.workspace_id AND a.id=agent_id AND a.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid)) AND resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND agent_credential_allows(conversation_id) AND (memory_sources_visible(workspace_id,sources,nullif(current_setting('ao.membership_id',true),'')::uuid) OR memory_release_valid(workspace_id,id,release_id,body,conversation_id,sources)));
