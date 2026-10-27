CREATE TABLE lifecycle_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,workspace_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('message','task','knowledge','file','transcript')),source_id uuid NOT NULL,request_key uuid NOT NULL,requested_by uuid REFERENCES accounts,reason text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','held','waiting_storage','waiting_receipts','completed','dead')),required_receipts text[] NOT NULL DEFAULT ARRAY['backup','runtime','provider','derived'],receipt_after timestamptz NOT NULL,lease uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,error_code text,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(organization_id,request_key),UNIQUE(workspace_id,kind,source_id),FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id));
CREATE INDEX lifecycle_pending ON lifecycle_jobs(workspace_id,available_at) WHERE state<>'completed';
CREATE TABLE deletion_receipts(id text PRIMARY KEY,job_id uuid NOT NULL REFERENCES lifecycle_jobs,processor text NOT NULL,evidence_hash text NOT NULL,signature text NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),UNIQUE(job_id,processor));
CREATE TABLE backup_inventory(id uuid PRIMARY KEY,region text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,manifest_hash text NOT NULL,deleted_at timestamptz,deletion_evidence text,CHECK(expires_at>created_at));
ALTER TABLE lifecycle_jobs ENABLE ROW LEVEL SECURITY;ALTER TABLE lifecycle_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON lifecycle_jobs TO ao_identity;
CREATE POLICY lifecycle_identity ON lifecycle_jobs TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON lifecycle_jobs TO ao_worker;
CREATE POLICY lifecycle_worker ON lifecycle_jobs TO ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
ALTER TABLE deletion_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE deletion_receipts FORCE ROW LEVEL SECURITY;
GRANT SELECT ON deletion_receipts TO ao_identity;
CREATE POLICY deletion_identity ON deletion_receipts TO ao_identity USING(true);
ALTER TABLE backup_inventory ENABLE ROW LEVEL SECURITY;ALTER TABLE backup_inventory FORCE ROW LEVEL SECURITY;
GRANT SELECT ON backup_inventory TO ao_identity;
CREATE POLICY backup_identity ON backup_inventory TO ao_identity USING(true);
CREATE FUNCTION lifecycle_source(tenant uuid,kind text,target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item record;BEGIN
 IF current_setting('role',true)='ao_worker' AND tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN NULL;END IF;
 CASE kind
 WHEN 'message' THEN SELECT conversation_id,created_at INTO item FROM public.messages WHERE workspace_id=tenant AND id=target;
 WHEN 'task' THEN SELECT conversation_id,created_at INTO item FROM public.tasks WHERE workspace_id=tenant AND id=target;
 WHEN 'knowledge' THEN SELECT conversation_id,updated_at created_at INTO item FROM public.knowledge_pages WHERE workspace_id=tenant AND id=target;
 WHEN 'file' THEN SELECT conversation_id,created_at INTO item FROM public.files WHERE workspace_id=tenant AND id=target;
 WHEN 'transcript' THEN SELECT conversation_id,created_at INTO item FROM public.retained_transcripts WHERE workspace_id=tenant AND id=target;
 ELSE RETURN NULL;END CASE;
 IF item IS NULL THEN RETURN NULL;END IF;RETURN jsonb_build_object('conversationId',item.conversation_id,'createdAt',item.created_at);
END $body$;
CREATE FUNCTION erase_lifecycle_source(tenant uuid,target uuid,fence uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE job public.lifecycle_jobs;source jsonb;conversation uuid;BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR current_setting('role',true)<>'ao_worker' THEN RAISE EXCEPTION 'Worker authority required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.workspaces WHERE id=tenant FOR UPDATE;
 SELECT * INTO job FROM public.lifecycle_jobs WHERE workspace_id=tenant AND id=target AND lease=fence AND lease_until>now() FOR UPDATE;
 IF job.id IS NULL THEN RAISE EXCEPTION 'Lifecycle lease expired' USING ERRCODE='AOG03';END IF;
 source:=public.lifecycle_source(tenant,job.kind,job.source_id);conversation:=(source->>'conversationId')::uuid;
 IF (job.kind='knowledge' AND EXISTS(SELECT 1 FROM public.knowledge_retention WHERE workspace_id=tenant AND legal_hold)) OR EXISTS(SELECT 1 FROM public.legal_holds h WHERE h.workspace_id=tenant AND h.released_at IS NULL AND (h.conversation_id IS NULL OR h.conversation_id=conversation)) OR EXISTS(SELECT 1 FROM public.agent_memories m JOIN public.legal_holds h ON h.workspace_id=m.workspace_id AND (h.conversation_id IS NULL OR h.conversation_id=m.conversation_id) WHERE m.workspace_id=tenant AND m.sources::text LIKE '%'||job.source_id::text||'%' AND h.released_at IS NULL) THEN RETURN 'held';END IF;
 CASE job.kind
 WHEN 'message' THEN UPDATE public.messages SET body='',deleted_by=coalesce(deleted_by,(SELECT m.id FROM public.memberships m WHERE m.workspace_id=tenant AND m.account_id=job.requested_by LIMIT 1),author_id),deleted_at=coalesce(deleted_at,now()),version=version+1 WHERE workspace_id=tenant AND id=job.source_id AND (body<>'' OR deleted_at IS NULL);
 WHEN 'task' THEN
  UPDATE public.tasks SET title='[erased]',description='',state='cancelled',version=version+1 WHERE workspace_id=tenant AND id=job.source_id AND title<>'[erased]';
  UPDATE public.task_comments SET body='',deleted_at=coalesce(deleted_at,now()),deleted_by=coalesce(deleted_by,author_id),version=version+1 WHERE workspace_id=tenant AND task_id=job.source_id AND deleted_at IS NULL;
  UPDATE public.task_artifacts SET title='[erased]',details='',url=NULL WHERE workspace_id=tenant AND task_id=job.source_id;
  UPDATE public.task_criteria SET text='[erased]',evidence=CASE WHEN accepted THEN '[erased]' ELSE '' END WHERE workspace_id=tenant AND task_id=job.source_id;
  UPDATE public.task_criterion_reviews SET evidence='[erased]' WHERE workspace_id=tenant AND task_id=job.source_id;
 WHEN 'knowledge' THEN
  UPDATE public.knowledge_pages SET title='[erased]',body='[erased]',version=version+1 WHERE workspace_id=tenant AND id=job.source_id AND body<>'[erased]';
  PERFORM set_config('ao.knowledge_purge','yes',true);
  DELETE FROM public.knowledge_versions WHERE workspace_id=tenant AND page_id=job.source_id;
  PERFORM set_config('ao.knowledge_purge','no',true);
  INSERT INTO public.knowledge_versions(id,workspace_id,page_id,title,body,version,author_id,summary) SELECT gen_random_uuid(),workspace_id,id,title,body,version,author_id,'Governed content erasure' FROM public.knowledge_pages WHERE workspace_id=tenant AND id=job.source_id;
  DELETE FROM public.knowledge_documents WHERE workspace_id=tenant AND page_id=job.source_id;
  UPDATE public.knowledge_comments SET body='[erased]',anchor='' WHERE workspace_id=tenant AND page_id=job.source_id;
  UPDATE public.knowledge_reviews SET evidence='[erased]' WHERE workspace_id=tenant AND page_id=job.source_id;
  UPDATE public.knowledge_proposals SET title='[erased]',body='[erased]',status='invalidated' WHERE workspace_id=tenant AND page_id=job.source_id;
  UPDATE public.knowledge_schedules SET enabled=false WHERE workspace_id=tenant AND page_id=job.source_id;
  UPDATE public.knowledge_metadata SET state='archived',blocked=true WHERE workspace_id=tenant AND page_id=job.source_id;
 WHEN 'file' THEN UPDATE public.files SET status='deleting',cleanup_after=now() WHERE workspace_id=tenant AND id=job.source_id AND status<>'deleted' AND promoted_to IS NULL;
 WHEN 'transcript' THEN UPDATE public.retained_transcripts SET title='[erased]',body='[erased]',deleted_at=coalesce(deleted_at,now()),version=version+1 WHERE workspace_id=tenant AND id=job.source_id AND body<>'[erased]';
 END CASE;
 DELETE FROM public.retrieval_contexts WHERE workspace_id=tenant;
 DELETE FROM public.retrieval_documents WHERE workspace_id=tenant AND kind=job.kind AND source_id=job.source_id;
 DELETE FROM public.retrieval_chunks WHERE workspace_id=tenant AND kind=job.kind AND source_id=job.source_id;
 IF job.kind='file' THEN DELETE FROM public.file_extractions WHERE workspace_id=tenant AND file_id=job.source_id;END IF;
 UPDATE public.agent_memories SET title='[erased]',body='[erased]',deleted_at=coalesce(deleted_at,now()) WHERE workspace_id=tenant AND sources::text LIKE '%'||job.source_id::text||'%';
 UPDATE public.memory_revisions SET title='[erased]',body='[erased]' WHERE workspace_id=tenant AND sources::text LIKE '%'||job.source_id::text||'%';
 UPDATE public.retrieval_authority SET epoch=epoch+1 WHERE workspace_id=tenant;
 IF job.kind='file' AND EXISTS(SELECT 1 FROM public.files WHERE workspace_id=tenant AND id=job.source_id AND purged_at IS NULL) THEN RETURN 'waiting_storage';END IF;
 IF now()<job.receipt_after OR EXISTS(SELECT 1 FROM unnest(job.required_receipts) AS required(name) WHERE NOT EXISTS(SELECT 1 FROM public.deletion_receipts r WHERE r.job_id=job.id AND r.processor=required.name)) THEN RETURN 'waiting_receipts';END IF;
 RETURN 'completed';
END $body$;
REVOKE ALL ON FUNCTION lifecycle_source(uuid,text,uuid),erase_lifecycle_source(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle_source(uuid,text,uuid) TO ao_identity,ao_worker;
GRANT EXECUTE ON FUNCTION erase_lifecycle_source(uuid,uuid,uuid) TO ao_worker;
CREATE FUNCTION queue_governed_retention(tenant uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE org uuid;days integer;backup_days integer;cutoff timestamptz;added integer:=0;rows integer;kind text;table_name text;age_column text;extra text;BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR current_setting('role',true)<>'ao_worker' THEN RAISE EXCEPTION 'Worker authority required' USING ERRCODE='42501';END IF;
 SELECT w.organization_id,(g.policy->>'retentionDays')::integer,(g.policy->>'backupMaxDays')::integer INTO org,days,backup_days FROM public.workspaces w JOIN public.governance_policies g ON g.organization_id=w.organization_id WHERE w.id=tenant;
 IF days IS NULL THEN RETURN 0;END IF;cutoff:=now()-days*interval '1 day';
 FOREACH kind IN ARRAY ARRAY['message','task','knowledge','file','transcript'] LOOP
  table_name:=CASE kind WHEN 'message' THEN 'messages' WHEN 'task' THEN 'tasks' WHEN 'knowledge' THEN 'knowledge_pages' WHEN 'file' THEN 'files' ELSE 'retained_transcripts' END;
  age_column:=CASE kind WHEN 'knowledge' THEN 'updated_at' ELSE 'created_at' END;
  extra:=CASE kind WHEN 'task' THEN ' AND s.state IN (''completed'',''cancelled'')' WHEN 'file' THEN ' AND s.status=''attached'' AND s.promoted_to IS NULL AND NOT EXISTS(SELECT 1 FROM public.files newer WHERE newer.workspace_id=s.workspace_id AND newer.promoted_to=s.id AND newer.created_at>=$4)' ELSE '' END;
  EXECUTE format('INSERT INTO public.lifecycle_jobs(organization_id,workspace_id,kind,source_id,request_key,reason,receipt_after) SELECT $1,$2,$3,s.id,gen_random_uuid(),''Scheduled governance retention'',now()+$5*interval ''1 day'' FROM public.%I s WHERE s.workspace_id=$2 AND s.%I<$4 %s AND NOT EXISTS(SELECT 1 FROM public.lifecycle_jobs j WHERE j.workspace_id=$2 AND j.kind=$3 AND j.source_id=s.id) ORDER BY s.id LIMIT 20 ON CONFLICT DO NOTHING',table_name,age_column,extra) USING org,tenant,kind,cutoff,coalesce(backup_days,35);
  GET DIAGNOSTICS rows=ROW_COUNT;added:=added+rows;
 END LOOP;RETURN added;
END $body$;
REVOKE ALL ON FUNCTION queue_governed_retention(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION queue_governed_retention(uuid) TO ao_worker;
