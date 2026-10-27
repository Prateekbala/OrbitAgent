CREATE TABLE knowledge_metadata (
 workspace_id uuid NOT NULL, page_id uuid NOT NULL, conversation_id uuid, created_at timestamptz NOT NULL,
 owner_id uuid NOT NULL,kind text NOT NULL DEFAULT 'page' CHECK(kind IN ('page','dictionary','decision','procedure','project_context','summary','journal')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','deleted')),
 review_state text NOT NULL DEFAULT 'draft' CHECK(review_state IN ('draft','in_review','approved','stale','contradicted')),
 version integer NOT NULL DEFAULT 1,fresh_until timestamptz,superseded_by uuid,blocked boolean NOT NULL DEFAULT false,deleted_at timestamptz,
 PRIMARY KEY(workspace_id,page_id),FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,superseded_by) REFERENCES knowledge_pages(workspace_id,id),
 CHECK((state='deleted')=(deleted_at IS NOT NULL)),CHECK(superseded_by IS NULL OR superseded_by<>page_id)
);
INSERT INTO knowledge_metadata(workspace_id,page_id,conversation_id,created_at,owner_id)
 SELECT p.workspace_id,p.id,p.conversation_id,p.created_at,coalesce(a.owner_id,p.author_id) FROM knowledge_pages p LEFT JOIN agents a ON a.workspace_id=p.workspace_id AND a.membership_id=p.author_id;
CREATE TABLE knowledge_documents (
 workspace_id uuid NOT NULL,page_id uuid NOT NULL,generation uuid NOT NULL DEFAULT gen_random_uuid(),state text NOT NULL,
 PRIMARY KEY(workspace_id,page_id),FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id)
);
CREATE TABLE knowledge_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,page_id uuid NOT NULL,
 source_page_id uuid,source_message_id uuid,source_version integer NOT NULL CHECK(source_version>0),stale boolean NOT NULL DEFAULT false,
 FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),
 FOREIGN KEY(workspace_id,source_page_id) REFERENCES knowledge_pages(workspace_id,id),
 FOREIGN KEY(workspace_id,source_message_id) REFERENCES messages(workspace_id,id),
 CHECK((source_page_id IS NULL)<>(source_message_id IS NULL)),CHECK(source_page_id IS NULL OR source_page_id<>page_id)
);
CREATE UNIQUE INDEX knowledge_source_page_unique ON knowledge_sources(workspace_id,page_id,source_page_id) WHERE source_page_id IS NOT NULL;
CREATE UNIQUE INDEX knowledge_source_message_unique ON knowledge_sources(workspace_id,page_id,source_message_id) WHERE source_message_id IS NOT NULL;
CREATE TABLE knowledge_reviewers (
 workspace_id uuid NOT NULL,page_id uuid NOT NULL,member_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,page_id,member_id),FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE knowledge_comments (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,page_id uuid NOT NULL,author_id uuid NOT NULL,body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),anchor text NOT NULL DEFAULT '',
 resolved_at timestamptz,resolved_by uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),FOREIGN KEY(workspace_id,author_id) REFERENCES memberships(workspace_id,id),FOREIGN KEY(workspace_id,resolved_by) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX knowledge_comments_timeline ON knowledge_comments(workspace_id,page_id,created_at DESC,id DESC);
CREATE TABLE knowledge_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,page_id uuid NOT NULL,reviewer_id uuid NOT NULL,page_version integer NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','changes_requested','contradiction')),
 evidence text NOT NULL CHECK(length(evidence) BETWEEN 5 AND 4000),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),FOREIGN KEY(workspace_id,reviewer_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE knowledge_schedules (
 workspace_id uuid NOT NULL,page_id uuid NOT NULL,owner_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT true,interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 365),source_ids uuid[] NOT NULL,
 next_at timestamptz NOT NULL DEFAULT now(),last_error text,
 PRIMARY KEY(workspace_id,page_id),FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE knowledge_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,page_id uuid NOT NULL,base_version integer NOT NULL,
 title text NOT NULL,body text NOT NULL,sources jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','invalidated')),
 reviewed_by uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id),FOREIGN KEY(workspace_id,reviewed_by) REFERENCES memberships(workspace_id,id)
);
CREATE UNIQUE INDEX knowledge_proposal_open ON knowledge_proposals(workspace_id,page_id) WHERE status='pending';
CREATE TABLE knowledge_retention (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),days integer NOT NULL DEFAULT 30 CHECK(days BETWEEN 7 AND 3650),legal_hold boolean NOT NULL DEFAULT false
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['knowledge_metadata','knowledge_documents','knowledge_sources','knowledge_reviewers','knowledge_comments','knowledge_reviews','knowledge_schedules','knowledge_proposals','knowledge_retention'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 IF name NOT IN ('knowledge_metadata','knowledge_retention') THEN
 EXECUTE format('CREATE POLICY knowledge_audience ON %I AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.workspace_id=%I.workspace_id AND p.id=page_id)) WITH CHECK(EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.workspace_id=%I.workspace_id AND p.id=page_id))',name,name,name);
 END IF;
 END LOOP;
END $$;
CREATE POLICY metadata_audience ON knowledge_metadata AS RESTRICTIVE TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND agent_credential_allows(conversation_id));
CREATE POLICY knowledge_lifecycle ON knowledge_pages AS RESTRICTIVE FOR SELECT TO ao_runtime USING(EXISTS(SELECT 1 FROM knowledge_metadata m WHERE m.workspace_id=knowledge_pages.workspace_id AND m.page_id=id AND m.state<>'deleted'));
CREATE FUNCTION initialize_knowledge_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO knowledge_metadata(workspace_id,page_id,conversation_id,created_at,owner_id) SELECT NEW.workspace_id,NEW.id,NEW.conversation_id,NEW.created_at,coalesce((SELECT owner_id FROM agents WHERE workspace_id=NEW.workspace_id AND membership_id=NEW.author_id),NEW.author_id);RETURN NEW;END $$;
CREATE TRIGGER knowledge_metadata_init AFTER INSERT ON knowledge_pages FOR EACH ROW EXECUTE FUNCTION initialize_knowledge_metadata();
CREATE FUNCTION validate_knowledge_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audience uuid; source_audience uuid; BEGIN
 SELECT conversation_id INTO audience FROM knowledge_pages WHERE workspace_id=NEW.workspace_id AND id=NEW.page_id;
 IF NEW.source_page_id IS NOT NULL THEN SELECT conversation_id INTO source_audience FROM knowledge_pages WHERE workspace_id=NEW.workspace_id AND id=NEW.source_page_id;
 IF EXISTS(WITH RECURSIVE parents(id) AS (SELECT NEW.source_page_id UNION SELECT s.source_page_id FROM knowledge_sources s JOIN parents p ON s.page_id=p.id WHERE s.workspace_id=NEW.workspace_id AND s.source_page_id IS NOT NULL) SELECT 1 FROM parents WHERE id=NEW.page_id) THEN RAISE EXCEPTION 'Knowledge source cycle' USING ERRCODE='23514';END IF;
 ELSE SELECT conversation_id INTO source_audience FROM messages WHERE workspace_id=NEW.workspace_id AND id=NEW.source_message_id; END IF;
 IF audience IS DISTINCT FROM source_audience THEN RAISE EXCEPTION 'Knowledge sources must retain the same audience' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER knowledge_source_guard BEFORE INSERT OR UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION validate_knowledge_source();
CREATE FUNCTION propagate_knowledge_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE deleted boolean := false; target uuid; source_kind text; BEGIN
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
CREATE TRIGGER knowledge_change_propagation AFTER UPDATE OF body,title ON knowledge_pages FOR EACH ROW EXECUTE FUNCTION propagate_knowledge_change();
CREATE TRIGGER message_knowledge_propagation AFTER UPDATE OF body,deleted_at ON messages FOR EACH ROW EXECUTE FUNCTION propagate_knowledge_change();
CREATE TRIGGER lifecycle_knowledge_propagation AFTER UPDATE OF state,blocked ON knowledge_metadata FOR EACH ROW EXECUTE FUNCTION propagate_knowledge_change();
REVOKE ALL ON FUNCTION initialize_knowledge_metadata(),validate_knowledge_source(),propagate_knowledge_change() FROM PUBLIC;
CREATE FUNCTION protect_knowledge_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.page_id,NEW.conversation_id,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.page_id,OLD.conversation_id,OLD.created_at) THEN RAISE EXCEPTION 'Knowledge audience and identity are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER metadata_identity BEFORE UPDATE ON knowledge_metadata FOR EACH ROW EXECUTE FUNCTION protect_knowledge_metadata();
REVOKE ALL ON FUNCTION protect_knowledge_metadata() FROM PUBLIC;
CREATE OR REPLACE FUNCTION protect_knowledge_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND current_setting('ao.knowledge_purge',true)='yes' AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.knowledge_versions'::regclass) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Knowledge revisions are immutable' USING ERRCODE='23514';END $$;
CREATE FUNCTION purge_deleted_knowledge(tenant uuid,target uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
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
 DELETE FROM public.knowledge_versions WHERE workspace_id=tenant AND page_id=target;
 DELETE FROM public.knowledge_pages WHERE workspace_id=tenant AND id=target;
 PERFORM set_config('ao.knowledge_purge','no',true);RETURN true;END $$;
REVOKE ALL ON FUNCTION purge_deleted_knowledge(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_deleted_knowledge(uuid,uuid) TO ao_worker;
