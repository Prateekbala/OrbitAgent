ALTER TABLE files ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN retrieval_version integer NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN promoted_to uuid;
ALTER TABLE files ADD COLUMN dlp_status text NOT NULL DEFAULT 'uninspected' CHECK(dlp_status IN ('clean','blocked','uninspected'));
ALTER TABLE files ADD COLUMN dlp_policy_version integer NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN dlp_findings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE files ADD COLUMN dlp_lease uuid;
ALTER TABLE files ADD COLUMN dlp_lease_until timestamptz;
ALTER TABLE files ADD CONSTRAINT file_promoted_root FOREIGN KEY(workspace_id,promoted_to) REFERENCES files(workspace_id,id);
CREATE TABLE file_versions (
 workspace_id uuid NOT NULL, file_id uuid NOT NULL, version integer NOT NULL, added_by uuid NOT NULL, client_id uuid NOT NULL,
 name text NOT NULL,size integer NOT NULL,sha256 text NOT NULL,content_type text NOT NULL,object_key text NOT NULL,preview_key text,storage_provider text NOT NULL,successor_id uuid,
 dlp_status text NOT NULL,dlp_policy_version integer NOT NULL,dlp_findings jsonb NOT NULL DEFAULT '[]',dlp_lease uuid,dlp_lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,file_id,version),UNIQUE(workspace_id,file_id,client_id),
 FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id),FOREIGN KEY(workspace_id,added_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE file_upload_sessions (
 workspace_id uuid NOT NULL,file_id uuid NOT NULL,membership_id uuid NOT NULL,received_bytes integer NOT NULL DEFAULT 0,completed_at timestamptz,
 PRIMARY KEY(workspace_id,file_id),FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id),FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE file_upload_chunks (
 workspace_id uuid NOT NULL,file_id uuid NOT NULL,offset_bytes integer NOT NULL,size integer NOT NULL,sha256 text NOT NULL,object_key text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','complete')),lease uuid NOT NULL,lease_until timestamptz NOT NULL,cleanup_after timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,file_id,offset_bytes),FOREIGN KEY(workspace_id,file_id) REFERENCES file_upload_sessions(workspace_id,file_id)
);
CREATE TABLE file_dlp_policies (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces,version integer NOT NULL,policy jsonb NOT NULL,updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,updated_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE file_shares (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,file_id uuid NOT NULL,file_version integer NOT NULL,created_by uuid NOT NULL,token_hash text NOT NULL UNIQUE,
 recipients uuid[] NOT NULL,expires_at timestamptz NOT NULL,max_downloads integer NOT NULL,downloads integer NOT NULL DEFAULT 0,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id),CHECK(downloads BETWEEN 0 AND max_downloads)
);
DO $body$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['file_versions','file_upload_sessions','file_upload_chunks','file_dlp_policies','file_shares'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',t);
 END LOOP;
END $body$;
CREATE POLICY version_audience ON file_versions AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM files f WHERE f.workspace_id=file_versions.workspace_id AND f.id=file_id)) WITH CHECK(EXISTS(SELECT 1 FROM files f WHERE f.workspace_id=file_versions.workspace_id AND f.id=file_id));
CREATE POLICY own_upload ON file_upload_sessions AS RESTRICTIVE TO ao_runtime USING(membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY own_chunk ON file_upload_chunks AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM file_upload_sessions s WHERE s.workspace_id=file_upload_chunks.workspace_id AND s.file_id=file_upload_chunks.file_id)) WITH CHECK(EXISTS(SELECT 1 FROM file_upload_sessions s WHERE s.workspace_id=file_upload_chunks.workspace_id AND s.file_id=file_upload_chunks.file_id));
CREATE POLICY share_audience ON file_shares AS RESTRICTIVE TO ao_runtime USING(created_by=nullif(current_setting('ao.membership_id',true),'')::uuid OR nullif(current_setting('ao.membership_id',true),'')::uuid=ANY(recipients)) WITH CHECK(created_by=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE FUNCTION invalidate_file_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF TG_TABLE_NAME='files' AND NEW.sha256=OLD.sha256 AND NEW.dlp_status=OLD.dlp_status AND NEW.dlp_policy_version=OLD.dlp_policy_version THEN RETURN NULL;END IF;
 UPDATE public.retrieval_authority SET epoch=epoch+1 WHERE workspace_id=NEW.workspace_id;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=NEW.workspace_id;
 UPDATE public.files f SET retrieval_version=greatest(f.retrieval_version,coalesce((SELECT e.version FROM public.file_extractions e WHERE e.workspace_id=f.workspace_id AND e.file_id=f.id),0))+1 WHERE f.workspace_id=NEW.workspace_id AND f.id=NEW.id;
 DELETE FROM public.file_extractions WHERE workspace_id=NEW.workspace_id AND (TG_TABLE_NAME='file_dlp_policies' OR file_id=NEW.id);
 UPDATE public.agent_memories SET deleted_at=now() WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL AND sources @> '[{"kind":"file"}]'::jsonb;
 RETURN NULL;
END $body$;
CREATE TRIGGER file_evidence_change AFTER UPDATE OF sha256,dlp_status,dlp_policy_version ON files FOR EACH ROW EXECUTE FUNCTION invalidate_file_evidence();
CREATE FUNCTION invalidate_file_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 UPDATE public.retrieval_authority SET epoch=epoch+1 WHERE workspace_id=NEW.workspace_id;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=NEW.workspace_id;
 UPDATE public.files f SET retrieval_version=greatest(f.retrieval_version,coalesce((SELECT e.version FROM public.file_extractions e WHERE e.workspace_id=f.workspace_id AND e.file_id=f.id),0))+1 WHERE f.workspace_id=NEW.workspace_id;
 DELETE FROM public.file_extractions WHERE workspace_id=NEW.workspace_id;
 UPDATE public.agent_memories SET deleted_at=now() WHERE workspace_id=NEW.workspace_id AND deleted_at IS NULL AND sources @> '[{"kind":"file"}]'::jsonb;
 RETURN NULL;END $body$;
CREATE TRIGGER file_policy_evidence AFTER INSERT OR UPDATE ON file_dlp_policies FOR EACH ROW EXECUTE FUNCTION invalidate_file_policy();
REVOKE DELETE ON file_dlp_policies FROM ao_runtime;
CREATE POLICY dlp_editor_update ON file_dlp_policies AS RESTRICTIVE FOR UPDATE TO ao_runtime USING(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=file_dlp_policies.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.kind='human' AND m.role IN ('owner','admin'))) WITH CHECK(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=file_dlp_policies.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.role IN ('owner','admin')));
CREATE POLICY dlp_editor_insert ON file_dlp_policies AS RESTRICTIVE FOR INSERT TO ao_runtime WITH CHECK(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=file_dlp_policies.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND m.kind='human' AND m.role IN ('owner','admin')));
CREATE FUNCTION file_share_creator_current(tenant uuid,member uuid,target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.files f JOIN public.memberships m ON m.workspace_id=f.workspace_id AND m.id=member WHERE f.workspace_id=tenant AND f.id=target AND m.status='active' AND coalesce((m.permissions->>'files.read')::boolean,true) AND public.retrieval_principal_current(tenant,member) AND public.resource_visible_to(tenant,f.conversation_id,f.created_at,member) AND (f.task_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.message_attachments a JOIN public.messages msg ON msg.workspace_id=a.workspace_id AND msg.id=a.message_id WHERE a.workspace_id=tenant AND a.file_id=target AND msg.deleted_at IS NULL AND public.message_visible_to(tenant,msg.conversation_id,msg.sequence,msg.thread_id,member))))
$body$;
REVOKE ALL ON FUNCTION file_share_creator_current(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION file_share_creator_current(uuid,uuid,uuid) TO ao_runtime;

REVOKE UPDATE ON file_shares FROM ao_runtime;
GRANT UPDATE(revoked_at) ON file_shares TO ao_runtime;
CREATE FUNCTION consume_file_share(tenant uuid,target uuid,proof text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN false;END IF;
 UPDATE public.file_shares s SET downloads=downloads+1 WHERE s.workspace_id=tenant AND s.id=target AND s.token_hash=proof
 AND nullif(current_setting('ao.membership_id',true),'')::uuid=ANY(s.recipients)
 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.downloads<s.max_downloads
 AND public.file_share_creator_current(tenant,s.created_by,s.file_id);
 RETURN FOUND;
END $body$;
REVOKE ALL ON FUNCTION consume_file_share(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_file_share(uuid,uuid,text) TO ao_runtime;

CREATE OR REPLACE FUNCTION retrieval_source_version(tenant uuid,kind text,target uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE revision integer; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN NULL; END IF;
 CASE kind
 WHEN 'message' THEN SELECT version INTO revision FROM public.messages WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL;
 WHEN 'knowledge' THEN SELECT p.version INTO revision FROM public.knowledge_pages p JOIN public.knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=tenant AND p.id=target AND m.state='active' AND NOT m.blocked AND m.superseded_by IS NULL;
 WHEN 'task' THEN SELECT version INTO revision FROM public.tasks WHERE workspace_id=tenant AND id=target;
 WHEN 'file' THEN SELECT coalesce(e.version,f.retrieval_version) INTO revision FROM public.files f LEFT JOIN public.file_extractions e ON e.workspace_id=f.workspace_id AND e.file_id=f.id WHERE f.workspace_id=tenant AND f.id=target AND f.status='attached' AND f.scan_status IN ('clean','development_only');
 WHEN 'document' THEN SELECT r.version INTO revision FROM public.connection_resources r JOIN public.connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id WHERE r.workspace_id=tenant AND r.id=target AND r.deleted_at IS NULL AND r.retained_until>now() AND c.state='connected';
 WHEN 'transcript' THEN SELECT version INTO revision FROM public.retained_transcripts WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL AND retained_until>now();
 WHEN 'memory' THEN SELECT version INTO revision FROM public.agent_memories WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL AND expires_at>now();
 ELSE RETURN NULL; END CASE;
 RETURN revision; END $$;
CREATE OR REPLACE FUNCTION retrieval_source_visible(tenant uuid,kind text,target uuid,member uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean; permission text; principal record; memory record; ref jsonb; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR depth>16 THEN RETURN false;END IF;
 SELECT * INTO principal FROM public.memberships WHERE workspace_id=tenant AND id=member AND status='active';
 IF principal.id IS NULL OR NOT public.retrieval_principal_current(tenant,member) THEN RETURN false;END IF;
 permission:=CASE kind WHEN 'message' THEN 'messages.read' WHEN 'task' THEN 'tasks.read' WHEN 'file' THEN 'files.read' ELSE 'knowledge.read' END;
 IF principal.permissions->>permission='false' OR principal.access_type='service' AND NOT coalesce((principal.permissions->>permission)::boolean,false) OR principal.access_type='guest' AND kind IN ('document','memory','transcript') THEN RETURN false;END IF;
 IF kind='file' AND EXISTS(SELECT 1 FROM public.file_dlp_policies p WHERE p.workspace_id=tenant AND (p.policy->>'enabled')::boolean AND NOT EXISTS(SELECT 1 FROM public.files f WHERE f.workspace_id=tenant AND f.id=target AND f.dlp_policy_version=p.version AND f.dlp_status<>'blocked' AND (NOT (p.policy->>'requireInspection')::boolean OR f.dlp_status='clean'))) THEN RETURN false;END IF;
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

CREATE OR REPLACE FUNCTION guard_file_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.conversation_id,NEW.task_id,NEW.uploader_id,NEW.client_id) IS DISTINCT FROM (OLD.workspace_id,OLD.conversation_id,OLD.task_id,OLD.uploader_id,OLD.client_id) THEN RAISE EXCEPTION 'Immutable file source'; END IF;
 IF NEW.task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND t.conversation_id IS NOT DISTINCT FROM NEW.conversation_id) THEN RAISE EXCEPTION 'Task file audience mismatch'; END IF;
 RETURN NEW;
END $$;
