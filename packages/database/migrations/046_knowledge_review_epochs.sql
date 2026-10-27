ALTER TABLE knowledge_metadata ADD COLUMN review_epoch integer NOT NULL DEFAULT 1 CHECK(review_epoch>0);
ALTER TABLE knowledge_reviews ADD COLUMN review_epoch integer NOT NULL DEFAULT 1 CHECK(review_epoch>0);
CREATE OR REPLACE FUNCTION protect_knowledge_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.page_id,NEW.conversation_id,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.page_id,OLD.conversation_id,OLD.created_at) THEN RAISE EXCEPTION 'Knowledge audience and identity are immutable' USING ERRCODE='23514';END IF;
 IF (NEW.owner_id,NEW.kind,NEW.fresh_until,NEW.superseded_by,NEW.state) IS DISTINCT FROM (OLD.owner_id,OLD.kind,OLD.fresh_until,OLD.superseded_by,OLD.state) THEN
 NEW.review_epoch:=OLD.review_epoch+1;IF NEW.review_state='approved' THEN NEW.review_state:='draft';END IF;
 END IF;RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION record_knowledge_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ DECLARE item record; BEGIN
 IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD;END IF;
 INSERT INTO knowledge_provenance(workspace_id,page_id,page_version,source_page_id,source_message_id,source_version,operation)
 SELECT item.workspace_id,item.page_id,p.version,item.source_page_id,item.source_message_id,item.source_version,CASE WHEN TG_OP='INSERT' THEN 'linked' ELSE 'removed' END FROM knowledge_pages p WHERE p.workspace_id=item.workspace_id AND p.id=item.page_id;
 UPDATE knowledge_metadata SET review_state=CASE WHEN review_state='approved' THEN 'draft' ELSE review_state END,review_epoch=review_epoch+1,version=version+1 WHERE workspace_id=item.workspace_id AND page_id=item.page_id;
 IF TG_OP='INSERT' THEN RETURN NEW; ELSE RETURN OLD;END IF;
END $$;
