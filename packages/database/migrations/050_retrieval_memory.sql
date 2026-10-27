CREATE TABLE retrieval_authority (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), epoch bigint NOT NULL DEFAULT 1
);
INSERT INTO retrieval_authority(workspace_id) SELECT id FROM workspaces;
CREATE TABLE retained_transcripts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, owner_id uuid NOT NULL,
 client_id uuid NOT NULL, title text NOT NULL, body text NOT NULL CHECK(length(body)<=200000), language text NOT NULL,
 consent_reference text NOT NULL, retained_until timestamptz NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(workspace_id,owner_id,client_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE agent_memories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL, owner_id uuid NOT NULL,
 boundary text NOT NULL CHECK(boundary IN ('private','conversation','workspace')), conversation_id uuid,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200), body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
 sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources) BETWEEN 1 AND 20),
 expires_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((boundary='conversation')=(conversation_id IS NOT NULL)), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE memory_revisions (
 workspace_id uuid NOT NULL, memory_id uuid NOT NULL, version integer NOT NULL, actor_id uuid NOT NULL,
 title text NOT NULL, body text NOT NULL, sources jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,memory_id,version), FOREIGN KEY(workspace_id,memory_id) REFERENCES agent_memories(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE file_extractions (
 workspace_id uuid NOT NULL, file_id uuid NOT NULL, version integer NOT NULL DEFAULT 1, body text NOT NULL CHECK(length(body)<=1000000), method text NOT NULL CHECK(method IN ('text','ocr')),
 sha256 text NOT NULL, extractor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,file_id),
 FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE retrieval_documents (
 workspace_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('message','knowledge','task','file','document','transcript','memory')), source_id uuid NOT NULL,
 source_version integer NOT NULL, title text NOT NULL, body text NOT NULL CHECK(length(body)<=1000000), language text NOT NULL DEFAULT 'und',
 freshness text NOT NULL DEFAULT 'current' CHECK(freshness IN ('current','stale')), conflict boolean NOT NULL DEFAULT false,
 indexed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,kind,source_id)
);
CREATE TABLE retrieval_chunks (
 workspace_id uuid NOT NULL, kind text NOT NULL, source_id uuid NOT NULL, ordinal integer NOT NULL,
 body text NOT NULL, terms tsvector NOT NULL, embedding double precision[], embedding_model text,
 PRIMARY KEY(workspace_id,kind,source_id,ordinal),
 FOREIGN KEY(workspace_id,kind,source_id) REFERENCES retrieval_documents(workspace_id,kind,source_id) ON DELETE CASCADE,
 CHECK(embedding IS NULL OR (cardinality(embedding) BETWEEN 1 AND 4096 AND embedding_model IS NOT NULL))
);
CREATE TABLE retrieval_jobs (
 workspace_id uuid NOT NULL, kind text NOT NULL, source_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','dead')),
 lease uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,kind,source_id)
);
CREATE TABLE retrieval_contexts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, member_id uuid NOT NULL, credential_id uuid,
 auth_version integer,policy_version integer NOT NULL,epoch bigint NOT NULL, sources jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE retrieval_metrics (
 workspace_id uuid NOT NULL, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), duration_ms integer NOT NULL,
 candidate_count integer NOT NULL, result_count integer NOT NULL, mode text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION retrieval_principal_current(tenant uuid,member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=tenant AND m.id=member AND m.status='active' AND (m.kind='agent' OR EXISTS(SELECT 1 FROM public.accounts a JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.organizations o ON o.id=w.organization_id JOIN public.organization_members om ON om.organization_id=o.id AND om.account_id=a.id WHERE a.id=m.account_id AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL AND om.status='active' AND (m.access_type='guest' OR cardinality(o.allowed_domains)=0 OR split_part(a.email,'@',2)=ANY(o.allowed_domains)))))
$$;
CREATE FUNCTION retrieval_auth_version(tenant uuid,member uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT a.auth_version FROM public.memberships m JOIN public.accounts a ON a.id=m.account_id WHERE m.workspace_id=tenant AND m.id=member AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION retrieval_principal_current(uuid,uuid),retrieval_auth_version(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retrieval_principal_current(uuid,uuid),retrieval_auth_version(uuid,uuid) TO ao_runtime,ao_worker;
CREATE FUNCTION retrieval_source_version(tenant uuid,kind text,target uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE revision integer; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN NULL; END IF;
 CASE kind
 WHEN 'message' THEN SELECT version INTO revision FROM public.messages WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL;
 WHEN 'knowledge' THEN SELECT p.version INTO revision FROM public.knowledge_pages p JOIN public.knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=tenant AND p.id=target AND m.state='active' AND NOT m.blocked AND m.superseded_by IS NULL;
 WHEN 'task' THEN SELECT version INTO revision FROM public.tasks WHERE workspace_id=tenant AND id=target;
 WHEN 'file' THEN SELECT coalesce(e.version,1) INTO revision FROM public.files f LEFT JOIN public.file_extractions e ON e.workspace_id=f.workspace_id AND e.file_id=f.id WHERE f.workspace_id=tenant AND f.id=target AND f.status='attached' AND f.scan_status IN ('clean','development_only');
 WHEN 'document' THEN SELECT r.version INTO revision FROM public.connection_resources r JOIN public.connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id WHERE r.workspace_id=tenant AND r.id=target AND r.deleted_at IS NULL AND r.retained_until>now() AND c.state='connected';
 WHEN 'transcript' THEN SELECT version INTO revision FROM public.retained_transcripts WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL AND retained_until>now();
 WHEN 'memory' THEN SELECT version INTO revision FROM public.agent_memories WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL AND expires_at>now();
 ELSE RETURN NULL; END CASE;
 RETURN revision; END $$;
CREATE FUNCTION retrieval_source_visible(tenant uuid,kind text,target uuid,member uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
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
  FOR ref IN SELECT value FROM jsonb_array_elements(memory.sources) LOOP
   IF NOT public.retrieval_source_visible(tenant,ref->>'kind',(ref->>'id')::uuid,member,depth+1) OR public.retrieval_source_version(tenant,ref->>'kind',(ref->>'id')::uuid) IS DISTINCT FROM (ref->>'version')::integer THEN RETURN false;END IF;
  END LOOP; RETURN true;
 ELSE RETURN false;END CASE;
 RETURN coalesce(allowed,false); END $$;
REVOKE ALL ON FUNCTION retrieval_source_version(uuid,text,uuid),retrieval_source_visible(uuid,text,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retrieval_source_version(uuid,text,uuid),retrieval_source_visible(uuid,text,uuid,uuid,integer) TO ao_runtime,ao_worker;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['retrieval_authority','retained_transcripts','agent_memories','memory_revisions','file_extractions','retrieval_documents','retrieval_chunks','retrieval_jobs','retrieval_contexts','retrieval_metrics'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE POLICY source_audience ON retrieval_documents AS RESTRICTIVE FOR SELECT TO ao_runtime USING(retrieval_source_visible(workspace_id,kind,source_id,nullif(current_setting('ao.membership_id',true),'')::uuid) AND source_version=retrieval_source_version(workspace_id,kind,source_id));
CREATE POLICY chunk_audience ON retrieval_chunks AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM retrieval_documents d WHERE d.workspace_id=retrieval_chunks.workspace_id AND d.kind=retrieval_chunks.kind AND d.source_id=retrieval_chunks.source_id));
CREATE POLICY transcript_audience ON retained_transcripts AS RESTRICTIVE FOR SELECT TO ao_runtime USING(deleted_at IS NULL AND retained_until>now() AND resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND agent_credential_allows(conversation_id));
CREATE FUNCTION memory_sources_visible(tenant uuid,refs jsonb,member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE NOT public.retrieval_source_visible(tenant,r->>'kind',(r->>'id')::uuid,member))
$$;
REVOKE ALL ON FUNCTION memory_sources_visible(uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_sources_visible(uuid,jsonb,uuid) TO ao_runtime,ao_worker;
CREATE POLICY memory_audience ON agent_memories AS RESTRICTIVE FOR SELECT TO ao_runtime USING(deleted_at IS NULL AND expires_at>now() AND (boundary<>'private' OR owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM agents a WHERE a.workspace_id=agent_memories.workspace_id AND a.id=agent_id AND a.membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid)) AND resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND agent_credential_allows(conversation_id) AND memory_sources_visible(workspace_id,sources,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY revision_owner ON memory_revisions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM agent_memories m WHERE m.workspace_id=memory_revisions.workspace_id AND m.id=memory_id AND m.owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY extraction_audience ON file_extractions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(retrieval_source_visible(workspace_id,'file',file_id,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY context_owner ON retrieval_contexts AS RESTRICTIVE TO ao_runtime USING(member_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND credential_id IS NOT DISTINCT FROM nullif(current_setting('ao.agent_credential_id',true),'')::uuid AND epoch=(SELECT epoch FROM retrieval_authority a WHERE a.workspace_id=retrieval_contexts.workspace_id) AND expires_at>now() AND policy_version=workspace_policy_version(workspace_id) AND (auth_version IS NULL OR auth_version=retrieval_auth_version(workspace_id,member_id)));
REVOKE INSERT,UPDATE,DELETE ON retrieval_documents,retrieval_chunks,retrieval_jobs,retrieval_metrics,retrieval_authority FROM ao_runtime;
REVOKE SELECT ON retrieval_jobs,retrieval_metrics FROM ao_runtime;
CREATE INDEX retrieval_lexical ON retrieval_chunks USING gin(terms);
CREATE INDEX retrieval_jobs_dispatch ON retrieval_jobs(workspace_id,available_at) WHERE state IN ('pending','leased');
CREATE INDEX retrieval_context_expiry ON retrieval_contexts(workspace_id,expires_at);
CREATE FUNCTION queue_retrieval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item jsonb; k text; target uuid; BEGIN
 IF TG_OP='DELETE' THEN item:=to_jsonb(OLD); ELSE item:=to_jsonb(NEW);END IF;
 k:=TG_ARGV[0]; target:=(CASE WHEN TG_TABLE_NAME='knowledge_metadata' THEN item->>'page_id' WHEN TG_TABLE_NAME='file_extractions' THEN item->>'file_id' ELSE item->>'id' END)::uuid;
 INSERT INTO public.retrieval_jobs(workspace_id,kind,source_id) VALUES((item->>'workspace_id')::uuid,k,target)
 ON CONFLICT(workspace_id,kind,source_id) DO UPDATE SET generation=public.retrieval_jobs.generation+1,state='pending',lease=NULL,lease_until=NULL,attempts=0,available_at=now(),updated_at=now();
 RETURN NULL; END $$;
DO $$ DECLARE pair text[]; BEGIN
 FOREACH pair SLICE 1 IN ARRAY ARRAY[['messages','message'],['tasks','task'],['knowledge_pages','knowledge'],['knowledge_metadata','knowledge'],['files','file'],['file_extractions','file'],['connection_resources','document'],['retained_transcripts','transcript'],['agent_memories','memory']] LOOP
 EXECUTE format('CREATE TRIGGER retrieval_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION queue_retrieval(%L)',pair[1],pair[2]);END LOOP;END $$;
CREATE FUNCTION invalidate_retrieval_authority() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid; BEGIN
 IF TG_TABLE_NAME='connections' AND TG_OP='INSERT' THEN RETURN NULL;END IF;
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
CREATE TRIGGER retrieval_workspace AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER INSERT OR DELETE OR UPDATE OF status,role,permissions,access_type ON memberships FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER INSERT OR UPDATE OR DELETE ON conversation_members FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER DELETE OR UPDATE OF visibility,history_policy,archived_at ON conversations FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER INSERT OR UPDATE OR DELETE ON connection_grants FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER INSERT OR DELETE OR UPDATE OF state,owner_id,audience,version ON connections FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
CREATE TRIGGER retrieval_revocation AFTER INSERT OR DELETE OR UPDATE OF token_hash,scopes,conversation_ids,expires_at,revoked_at ON agent_credentials FOR EACH ROW EXECUTE FUNCTION invalidate_retrieval_authority();
REVOKE ALL ON FUNCTION queue_retrieval(),invalidate_retrieval_authority() FROM PUBLIC;
INSERT INTO retrieval_jobs(workspace_id,kind,source_id) SELECT workspace_id,'message',id FROM messages UNION ALL SELECT workspace_id,'task',id FROM tasks UNION ALL SELECT workspace_id,'knowledge',id FROM knowledge_pages UNION ALL SELECT workspace_id,'file',id FROM files;
GRANT SELECT(workspace_id) ON retrieval_authority TO ao_dispatcher;
ALTER TABLE agent_runs ADD COLUMN retrieval_epoch bigint;
CREATE FUNCTION capture_run_retrieval_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 SELECT epoch INTO NEW.retrieval_epoch FROM public.retrieval_authority WHERE workspace_id=NEW.workspace_id; RETURN NEW; END $$;
CREATE TRIGGER run_retrieval_epoch BEFORE INSERT ON agent_runs FOR EACH ROW EXECUTE FUNCTION capture_run_retrieval_epoch();
REVOKE ALL ON FUNCTION capture_run_retrieval_epoch() FROM PUBLIC;
CREATE POLICY retrieval_dispatch ON retrieval_authority TO ao_dispatcher USING(true);
CREATE TABLE retrieval_embedding_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,member_id uuid NOT NULL,credential_id uuid,
 kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,auth_version integer,policy_version integer NOT NULL,epoch bigint NOT NULL,model text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','dead')),next_ordinal integer NOT NULL DEFAULT 0,
 lease uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),
 error_code text,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id),
 UNIQUE NULLS NOT DISTINCT(workspace_id,member_id,credential_id,kind,source_id,source_version,model)
);
ALTER TABLE retrieval_embedding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval_embedding_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON retrieval_embedding_jobs TO ao_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON retrieval_embedding_jobs TO ao_worker;
CREATE POLICY tenant_boundary ON retrieval_embedding_jobs TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY job_owner ON retrieval_embedding_jobs AS RESTRICTIVE TO ao_runtime USING(member_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND credential_id IS NOT DISTINCT FROM nullif(current_setting('ao.agent_credential_id',true),'')::uuid) WITH CHECK(member_id=nullif(current_setting('ao.membership_id',true),'')::uuid AND credential_id IS NOT DISTINCT FROM nullif(current_setting('ao.agent_credential_id',true),'')::uuid);
CREATE INDEX retrieval_embedding_dispatch ON retrieval_embedding_jobs(workspace_id,available_at) WHERE state IN ('pending','leased');
