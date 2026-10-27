CREATE FUNCTION knowledge_lineage_visible(tenant uuid,target uuid,member uuid,revision integer DEFAULT NULL,owner_review boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean; BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN false;END IF;
 IF owner_review AND EXISTS(SELECT 1 FROM public.knowledge_metadata m JOIN public.memberships u ON u.workspace_id=m.workspace_id AND u.id=m.owner_id WHERE m.workspace_id=tenant AND m.page_id=target AND m.owner_id=member AND u.kind='human' AND u.status='active') THEN RETURN true;END IF;
 WITH RECURSIVE ancestors(page_id,version) AS (
  SELECT p.id,coalesce(revision,p.version) FROM public.knowledge_pages p WHERE p.workspace_id=tenant AND p.id=target
  UNION
  SELECT s.source_page_id,s.source_version FROM ancestors a JOIN LATERAL (
   SELECT DISTINCT ON(coalesce(h.source_page_id,h.source_message_id)) h.source_page_id,h.source_message_id,h.source_version,h.operation
   FROM public.knowledge_provenance h WHERE h.workspace_id=tenant AND h.page_id=a.page_id AND h.page_version<=a.version
   ORDER BY coalesce(h.source_page_id,h.source_message_id),h.page_version DESC,h.id DESC
  ) s ON s.operation='linked' AND s.source_page_id IS NOT NULL
 ), citations AS (
  SELECT s.* FROM ancestors a JOIN LATERAL (
   SELECT DISTINCT ON(coalesce(h.source_page_id,h.source_message_id)) h.source_page_id,h.source_message_id,h.source_version,h.operation
   FROM public.knowledge_provenance h WHERE h.workspace_id=tenant AND h.page_id=a.page_id AND h.page_version<=a.version
   ORDER BY coalesce(h.source_page_id,h.source_message_id),h.page_version DESC,h.id DESC
  ) s ON s.operation='linked'
 ) SELECT EXISTS(SELECT 1 FROM ancestors) AND NOT EXISTS(
  SELECT 1 FROM ancestors a LEFT JOIN public.knowledge_pages p ON p.workspace_id=tenant AND p.id=a.page_id
  LEFT JOIN public.knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id
  WHERE p.id IS NULL OR m.state='deleted' OR m.blocked OR NOT public.resource_visible_to(tenant,p.conversation_id,p.created_at,member)
 ) AND NOT EXISTS(
  SELECT 1 FROM citations c LEFT JOIN public.messages m ON m.workspace_id=tenant AND m.id=c.source_message_id
  WHERE c.source_message_id IS NOT NULL AND (m.id IS NULL OR m.deleted_at IS NOT NULL OR NOT public.message_visible_to(tenant,m.conversation_id,m.sequence,m.thread_id,member))
 ) INTO allowed;
 RETURN coalesce(allowed,false);END $$;
REVOKE ALL ON FUNCTION knowledge_lineage_visible(uuid,uuid,uuid,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge_lineage_visible(uuid,uuid,uuid,integer,boolean) TO ao_runtime,ao_worker;
CREATE POLICY knowledge_source_audience ON knowledge_pages AS RESTRICTIVE FOR SELECT TO ao_runtime USING(knowledge_lineage_visible(workspace_id,id,nullif(current_setting('ao.membership_id',true),'')::uuid,NULL,true));
CREATE POLICY knowledge_revision_sources ON knowledge_versions AS RESTRICTIVE FOR SELECT TO ao_runtime USING(knowledge_lineage_visible(workspace_id,page_id,nullif(current_setting('ao.membership_id',true),'')::uuid,version,true));
CREATE OR REPLACE FUNCTION record_knowledge_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item record; BEGIN
 IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD;END IF;
 INSERT INTO knowledge_provenance(workspace_id,page_id,page_version,source_page_id,source_message_id,source_version,operation)
 SELECT item.workspace_id,item.page_id,p.version+CASE WHEN TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.version AND v.created_at>=transaction_timestamp()) THEN 1 ELSE 0 END,item.source_page_id,item.source_message_id,item.source_version,CASE WHEN TG_OP='INSERT' THEN 'linked' ELSE 'removed' END FROM knowledge_pages p WHERE p.workspace_id=item.workspace_id AND p.id=item.page_id;
 UPDATE knowledge_metadata SET review_state=CASE WHEN review_state='approved' THEN 'draft' ELSE review_state END,review_epoch=review_epoch+1,version=version+1 WHERE workspace_id=item.workspace_id AND page_id=item.page_id;
 IF TG_OP='INSERT' THEN RETURN NEW; ELSE RETURN OLD;END IF;
END $$;
