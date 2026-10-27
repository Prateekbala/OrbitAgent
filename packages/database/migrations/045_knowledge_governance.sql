ALTER TABLE knowledge_metadata ADD COLUMN deletion_reason text CHECK(length(deletion_reason)<=500);
CREATE OR REPLACE FUNCTION record_knowledge_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item record; BEGIN
 IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD;END IF;
 INSERT INTO knowledge_provenance(workspace_id,page_id,page_version,source_page_id,source_message_id,source_version,operation)
 SELECT item.workspace_id,item.page_id,p.version,item.source_page_id,item.source_message_id,item.source_version,CASE WHEN TG_OP='INSERT' THEN 'linked' ELSE 'removed' END FROM knowledge_pages p WHERE p.workspace_id=item.workspace_id AND p.id=item.page_id;
 UPDATE knowledge_metadata SET review_state=CASE WHEN review_state='approved' THEN 'draft' ELSE review_state END,version=version+1 WHERE workspace_id=item.workspace_id AND page_id=item.page_id;
 IF TG_OP='INSERT' THEN RETURN NEW; ELSE RETURN OLD;END IF;
END $$;
CREATE OR REPLACE FUNCTION validate_knowledge_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE audience uuid; source_audience uuid; live_version integer; BEGIN
 SELECT conversation_id INTO audience FROM knowledge_pages WHERE workspace_id=NEW.workspace_id AND id=NEW.page_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge target unavailable' USING ERRCODE='23514';END IF;
 IF NEW.source_page_id IS NOT NULL THEN
  SELECT p.conversation_id,p.version INTO source_audience,live_version FROM knowledge_pages p JOIN knowledge_metadata m ON m.workspace_id=p.workspace_id AND m.page_id=p.id WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.source_page_id AND m.state='active' AND NOT m.blocked;
 ELSE
  SELECT conversation_id,version INTO source_audience,live_version FROM messages WHERE workspace_id=NEW.workspace_id AND id=NEW.source_message_id AND deleted_at IS NULL;
 END IF;
 IF TG_OP='INSERT' OR (NEW.source_page_id,NEW.source_message_id,NEW.source_version) IS DISTINCT FROM (OLD.source_page_id,OLD.source_message_id,OLD.source_version) THEN
  IF live_version IS NULL OR live_version<>NEW.source_version OR audience IS DISTINCT FROM source_audience THEN RAISE EXCEPTION 'Use a current knowledge source in the same audience' USING ERRCODE='23514';END IF;
  IF NEW.source_page_id IS NOT NULL AND EXISTS(WITH RECURSIVE parents(id) AS (SELECT NEW.source_page_id UNION SELECT s.source_page_id FROM knowledge_sources s JOIN parents p ON s.page_id=p.id WHERE s.workspace_id=NEW.workspace_id AND s.source_page_id IS NOT NULL) SELECT 1 FROM parents WHERE id=NEW.page_id) THEN RAISE EXCEPTION 'Knowledge source cycle' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;END $$;
