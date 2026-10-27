CREATE TABLE memory_release_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 source_memory_id uuid NOT NULL, source_version integer NOT NULL, requester_id uuid NOT NULL,
 target_conversation_id uuid, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
 body_hash text NOT NULL, title_hash text NOT NULL, epoch bigint NOT NULL, policy_version integer NOT NULL,
 requester_auth_version integer NOT NULL, expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','rejected','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,source_memory_id) REFERENCES agent_memories(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,requester_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,target_conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE memory_source_consents (
 workspace_id uuid NOT NULL, request_id uuid NOT NULL, owner_id uuid NOT NULL,
 sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources) BETWEEN 1 AND 128),
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','withdrawn')),
 auth_version integer, decided_at timestamptz,
 PRIMARY KEY(workspace_id,request_id,owner_id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES memory_release_requests(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE memory_releases ADD COLUMN consent_request_id uuid;
ALTER TABLE memory_releases ADD CONSTRAINT release_consent_request FOREIGN KEY(workspace_id,consent_request_id) REFERENCES memory_release_requests(workspace_id,id);
CREATE UNIQUE INDEX one_release_per_consent ON memory_releases(workspace_id,consent_request_id) WHERE consent_request_id IS NOT NULL;
CREATE INDEX memory_consent_inbox ON memory_source_consents(workspace_id,owner_id,request_id);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['memory_release_requests','memory_source_consents'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT ON %I TO ao_runtime',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE POLICY consent_owner ON memory_source_consents AS RESTRICTIVE TO ao_runtime USING(owner_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE POLICY request_participant ON memory_release_requests AS RESTRICTIVE TO ao_runtime USING(requester_id=nullif(current_setting('ao.membership_id',true),'')::uuid OR EXISTS(SELECT 1 FROM memory_source_consents c WHERE c.workspace_id=memory_release_requests.workspace_id AND c.request_id=id));

CREATE FUNCTION retrieval_direct_owner(tenant uuid,kind text,target uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner uuid; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN NULL; END IF;
 CASE kind
 WHEN 'message' THEN SELECT author_id INTO owner FROM public.messages WHERE workspace_id=tenant AND id=target AND deleted_at IS NULL;
 WHEN 'task' THEN SELECT created_by INTO owner FROM public.tasks WHERE workspace_id=tenant AND id=target;
 WHEN 'knowledge' THEN SELECT owner_id INTO owner FROM public.knowledge_metadata WHERE workspace_id=tenant AND page_id=target;
 WHEN 'file' THEN SELECT uploader_id INTO owner FROM public.files WHERE workspace_id=tenant AND id=target;
 WHEN 'document' THEN SELECT c.owner_id INTO owner FROM public.connection_resources r JOIN public.connections c ON c.workspace_id=r.workspace_id AND c.id=r.connection_id WHERE r.workspace_id=tenant AND r.id=target;
 WHEN 'transcript' THEN SELECT owner_id INTO owner FROM public.retained_transcripts WHERE workspace_id=tenant AND id=target;
 WHEN 'memory' THEN SELECT owner_id INTO owner FROM public.agent_memories WHERE workspace_id=tenant AND id=target;
 ELSE RETURN NULL; END CASE; RETURN owner;
END $$;
CREATE FUNCTION memory_consent_nodes(tenant uuid,target uuid,revision integer) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE nodes jsonb; exceeded boolean; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR public.retrieval_source_version(tenant,'memory',target) IS DISTINCT FROM revision THEN RETURN NULL; END IF;
 WITH RECURSIVE paths(kind,id,version,depth,ancestors,cycle) AS (
 SELECT 'memory'::text,target,revision,0,ARRAY[]::uuid[],false
 UNION ALL
 SELECT r->>'kind',(r->>'id')::uuid,(r->>'version')::integer,p.depth+1,p.ancestors||p.id,(r->>'id')::uuid=ANY(p.ancestors||p.id)
 FROM paths p CROSS JOIN LATERAL (
 SELECT m.sources refs FROM public.agent_memories m WHERE p.kind='memory' AND m.workspace_id=tenant AND m.id=p.id
 UNION ALL
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',CASE WHEN k.source_page_id IS NULL THEN 'message' ELSE 'knowledge' END,'id',coalesce(k.source_page_id,k.source_message_id),'version',k.source_version)),'[]'::jsonb) FROM public.knowledge_sources k WHERE p.kind='knowledge' AND k.workspace_id=tenant AND k.page_id=p.id HAVING p.kind='knowledge'
 ) refs CROSS JOIN LATERAL jsonb_array_elements(refs.refs) r WHERE p.depth<=7 AND NOT p.cycle
 ), bounded AS(SELECT * FROM paths LIMIT 129), unique_nodes AS(SELECT DISTINCT kind,id,version FROM bounded)
 SELECT (SELECT count(*)>128 OR coalesce(max(depth),0)>7 OR coalesce(bool_or(cycle),false) FROM bounded),
 jsonb_agg(jsonb_build_object('kind',n.kind,'id',n.id,'version',n.version,'ownerId',public.retrieval_direct_owner(tenant,n.kind,n.id)) ORDER BY n.kind,n.id,n.version)
 INTO exceeded,nodes FROM unique_nodes n;
 IF exceeded OR nodes IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'ownerId' IS NULL OR public.retrieval_source_version(tenant,n->>'kind',(n->>'id')::uuid) IS DISTINCT FROM (n->>'version')::integer) THEN RETURN NULL; END IF;
 RETURN nodes;
END $$;
REVOKE ALL ON FUNCTION retrieval_direct_owner(uuid,text,uuid),memory_consent_nodes(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retrieval_direct_owner(uuid,text,uuid),memory_consent_nodes(uuid,uuid,integer) TO ao_worker;

CREATE FUNCTION memory_consent_valid(tenant uuid,request uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r record;nodes jsonb;c record;expected jsonb; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN false;END IF;
 SELECT * INTO r FROM public.memory_release_requests WHERE workspace_id=tenant AND id=request;
 IF NOT FOUND OR r.state NOT IN ('pending','published') OR (r.state='pending' AND r.expires_at<=now()) OR r.policy_version<>public.workspace_policy_version(tenant) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.agent_memories m WHERE m.workspace_id=tenant AND m.id=r.source_memory_id AND m.version=r.source_version AND m.owner_id=r.requester_id AND m.deleted_at IS NULL AND m.expires_at>now() AND encode(sha256(convert_to(m.body,'UTF8')),'hex')=r.body_hash AND encode(sha256(convert_to(m.title,'UTF8')),'hex')=r.title_hash) THEN RETURN false;END IF;
 nodes:=public.memory_consent_nodes(tenant,r.source_memory_id,r.source_version);
 IF nodes IS NULL OR (SELECT count(DISTINCT n->>'ownerId') FROM jsonb_array_elements(nodes) n)<>(SELECT count(*) FROM public.memory_source_consents s WHERE s.workspace_id=tenant AND s.request_id=request) THEN RETURN false;END IF;
 FOR c IN SELECT * FROM public.memory_source_consents WHERE workspace_id=tenant AND request_id=request LOOP
  SELECT jsonb_agg(n ORDER BY n->>'kind',n->>'id',n->>'version') INTO expected FROM jsonb_array_elements(nodes) n WHERE n->>'ownerId'=c.owner_id::text;
  IF c.decision<>'approved' OR expected IS DISTINCT FROM c.sources OR NOT EXISTS(
   SELECT 1 FROM public.memberships m JOIN public.accounts a ON a.id=m.account_id
   WHERE m.workspace_id=tenant AND m.id=c.owner_id AND m.status='active' AND m.kind='human' AND m.access_type='member' AND coalesce((m.permissions->>'knowledge.write')::boolean,true)
   AND public.retrieval_principal_current(tenant,m.id) AND a.auth_version=c.auth_version AND a.disabled_at IS NULL AND a.email_verified_at IS NOT NULL
  ) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
REVOKE ALL ON FUNCTION memory_consent_valid(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_consent_valid(uuid,uuid) TO ao_worker;
CREATE OR REPLACE FUNCTION memory_release_valid(tenant uuid,target uuid,release uuid,body text,conversation uuid,refs jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.memory_releases r JOIN public.memberships m ON m.workspace_id=r.workspace_id AND m.id=r.approved_by
 WHERE r.workspace_id=tenant AND r.id=release AND r.published_memory_id=target AND r.revoked_at IS NULL AND r.target_conversation_id IS NOT DISTINCT FROM conversation
 AND r.body_hash=encode(sha256(convert_to(body,'UTF8')),'hex') AND r.sources=refs AND m.status='active' AND m.kind='human' AND m.access_type='member'
 AND public.retrieval_principal_current(tenant,m.id) AND coalesce((m.permissions->>'knowledge.write')::boolean,true)
 AND public.retrieval_provenance_current(tenant,'memory',r.source_memory_id,r.source_version)
 AND (CASE WHEN r.consent_request_id IS NULL THEN public.retrieval_source_owned(tenant,'memory',r.source_memory_id,r.approved_by)
 ELSE EXISTS(SELECT 1 FROM public.memory_release_requests q WHERE q.workspace_id=tenant AND q.id=r.consent_request_id AND q.source_memory_id=r.source_memory_id AND q.source_version=r.source_version AND q.requester_id=r.approved_by AND q.target_conversation_id IS NOT DISTINCT FROM conversation AND q.body_hash=r.body_hash AND q.state='published') AND public.memory_consent_valid(tenant,r.consent_request_id) END))
$$;
CREATE OR REPLACE FUNCTION protect_memory_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Release evidence is immutable; only revocation is allowed' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE FUNCTION protect_memory_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='memory_release_requests' THEN
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state<>'pending' THEN RAISE EXCEPTION 'Release request is immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['decision','auth_version','decided_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','auth_version','decided_at']) OR OLD.decision IN ('rejected','withdrawn') OR (OLD.decision='approved' AND NEW.decision<>'withdrawn') THEN RAISE EXCEPTION 'Source consent is immutable; an approval may only be withdrawn' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER protect_request BEFORE UPDATE ON memory_release_requests FOR EACH ROW EXECUTE FUNCTION protect_memory_consent();
CREATE TRIGGER protect_consent BEFORE UPDATE ON memory_source_consents FOR EACH ROW EXECUTE FUNCTION protect_memory_consent();
CREATE TRIGGER invalidate_consent AFTER UPDATE ON memory_source_consents FOR EACH ROW WHEN(NEW.decision='withdrawn') EXECUTE FUNCTION invalidate_retrieval_authority();
REVOKE ALL ON FUNCTION protect_memory_consent() FROM PUBLIC;
