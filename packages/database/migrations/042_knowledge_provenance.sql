CREATE TABLE knowledge_provenance (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id uuid NOT NULL,page_id uuid NOT NULL,page_version integer NOT NULL,
 source_page_id uuid,source_message_id uuid,source_version integer NOT NULL,operation text NOT NULL CHECK(operation IN ('linked','removed')),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id)
);
ALTER TABLE knowledge_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_provenance FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON knowledge_provenance TO ao_runtime,ao_worker;
GRANT USAGE ON SEQUENCE knowledge_provenance_id_seq TO ao_runtime,ao_worker;
CREATE POLICY tenant_boundary ON knowledge_provenance TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY source_history_audience ON knowledge_provenance AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.workspace_id=knowledge_provenance.workspace_id AND p.id=page_id));
CREATE FUNCTION record_knowledge_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE item record; BEGIN
 IF TG_OP='INSERT' THEN item:=NEW; ELSE item:=OLD;END IF;
 INSERT INTO knowledge_provenance(workspace_id,page_id,page_version,source_page_id,source_message_id,source_version,operation)
 SELECT item.workspace_id,item.page_id,p.version,item.source_page_id,item.source_message_id,item.source_version,CASE WHEN TG_OP='INSERT' THEN 'linked' ELSE 'removed' END FROM knowledge_pages p WHERE p.workspace_id=item.workspace_id AND p.id=item.page_id;
 IF TG_OP='INSERT' THEN RETURN NEW; ELSE RETURN OLD;END IF;
END $$;
CREATE TRIGGER knowledge_source_provenance AFTER INSERT OR DELETE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION record_knowledge_source();
REVOKE ALL ON FUNCTION record_knowledge_source() FROM PUBLIC;
CREATE FUNCTION protect_knowledge_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND current_setting('ao.knowledge_purge',true)='yes' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.knowledge_provenance'::regclass) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Provenance events are immutable' USING ERRCODE='23514';END $$;
CREATE TRIGGER knowledge_provenance_guard BEFORE UPDATE OR DELETE ON knowledge_provenance FOR EACH ROW EXECUTE FUNCTION protect_knowledge_provenance();
REVOKE ALL ON FUNCTION protect_knowledge_provenance() FROM PUBLIC;
CREATE OR REPLACE FUNCTION purge_deleted_knowledge(tenant uuid,target uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid THEN RETURN false;END IF;
 PERFORM id FROM public.workspaces WHERE id=tenant FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.knowledge_metadata m LEFT JOIN public.knowledge_retention r ON r.workspace_id=m.workspace_id WHERE m.workspace_id=tenant AND m.page_id=target AND m.state='deleted' AND NOT coalesce(r.legal_hold,false) AND m.deleted_at<now()-coalesce(r.days,30)*interval '1 day') THEN RETURN false;END IF;
 DELETE FROM public.knowledge_sources WHERE workspace_id=tenant AND (page_id=target OR source_page_id=target);
 DELETE FROM public.knowledge_documents WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_reviewers WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_reviews WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_comments WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_schedules WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_proposals WHERE workspace_id=tenant AND page_id=target;
 UPDATE public.knowledge_metadata SET superseded_by=NULL WHERE workspace_id=tenant AND superseded_by=target;
 DELETE FROM public.knowledge_metadata WHERE workspace_id=tenant AND page_id=target;
 PERFORM set_config('ao.knowledge_purge','yes',true);
 DELETE FROM public.knowledge_provenance WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_versions WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_pages WHERE workspace_id=tenant AND id=target;
 PERFORM set_config('ao.knowledge_purge','no',true);RETURN true;END $$;
CREATE FUNCTION propagate_canonical_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF pg_trigger_depth()>1 THEN RETURN NEW;END IF;
 IF (NEW.review_state,NEW.superseded_by) IS NOT DISTINCT FROM (OLD.review_state,OLD.superseded_by) THEN RETURN NEW;END IF;
 IF NEW.review_state IN ('stale','contradicted') OR NEW.superseded_by IS NOT NULL THEN
 WITH RECURSIVE derived(id) AS (SELECT page_id FROM public.knowledge_sources WHERE workspace_id=NEW.workspace_id AND source_page_id=NEW.page_id UNION SELECT s.page_id FROM public.knowledge_sources s JOIN derived d ON s.source_page_id=d.id WHERE s.workspace_id=NEW.workspace_id)
 UPDATE public.knowledge_metadata SET review_state='stale',blocked=blocked OR NEW.review_state='contradicted',version=version+1 WHERE workspace_id=NEW.workspace_id AND page_id IN(SELECT id FROM derived) AND (review_state<>'stale' OR NEW.review_state='contradicted' AND NOT blocked);
 UPDATE public.knowledge_sources SET stale=true WHERE workspace_id=NEW.workspace_id AND source_page_id=NEW.page_id;
 UPDATE public.knowledge_proposals p SET status='invalidated' WHERE p.workspace_id=NEW.workspace_id AND p.status='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.sources) s WHERE s->>'id'=NEW.page_id::text);
 END IF;RETURN NEW;END $$;
CREATE TRIGGER knowledge_canonical_status AFTER UPDATE OF review_state,superseded_by ON knowledge_metadata FOR EACH ROW EXECUTE FUNCTION propagate_canonical_status();
REVOKE ALL ON FUNCTION propagate_canonical_status() FROM PUBLIC;
