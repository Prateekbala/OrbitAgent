CREATE OR REPLACE FUNCTION propagate_knowledge_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deleted boolean := false; target uuid; source_kind text; BEGIN
 IF TG_TABLE_NAME='knowledge_metadata' AND pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='messages' THEN deleted:=NEW.deleted_at IS NOT NULL;target:=NEW.id;source_kind:='message';
 ELSIF TG_TABLE_NAME='knowledge_metadata' THEN
  IF NEW.state=OLD.state AND NEW.blocked=OLD.blocked THEN RETURN NEW;END IF;
  deleted:=NEW.state IN ('deleted','archived') OR NEW.blocked;target:=NEW.page_id;source_kind:='page';
 ELSE target:=NEW.id;source_kind:='page';
 UPDATE public.knowledge_metadata SET review_state=CASE WHEN review_state IN ('approved','in_review') THEN 'draft' ELSE review_state END,version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id=target;
 END IF;
 WITH RECURSIVE derived(id) AS (
 SELECT s.page_id FROM public.knowledge_sources s WHERE s.workspace_id=NEW.workspace_id AND
 ((source_kind='message' AND s.source_message_id=target) OR (source_kind='page' AND s.source_page_id=target))
 UNION SELECT s.page_id FROM public.knowledge_sources s JOIN derived d ON s.source_page_id=d.id WHERE s.workspace_id=NEW.workspace_id
 ) UPDATE public.knowledge_metadata SET review_state='stale',blocked=blocked OR deleted,version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id IN(SELECT id FROM derived) AND (review_state<>'stale' OR deleted AND NOT blocked);
 UPDATE public.knowledge_sources s SET stale=true WHERE s.workspace_id=NEW.workspace_id AND ((source_kind='message' AND s.source_message_id=target) OR (source_kind='page' AND s.source_page_id=target));
 UPDATE public.knowledge_proposals p SET status='invalidated' WHERE p.workspace_id=NEW.workspace_id AND p.status='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.sources) s WHERE (source_kind='message' AND s->>'messageId'=target::text) OR (source_kind='page' AND s->>'id'=target::text));
 RETURN NEW;END $$;
ALTER FUNCTION validate_knowledge_source() SET search_path=pg_catalog,public;
ALTER FUNCTION record_knowledge_source() SET search_path=pg_catalog,public;
ALTER FUNCTION initialize_knowledge_metadata() SET search_path=pg_catalog,public;
