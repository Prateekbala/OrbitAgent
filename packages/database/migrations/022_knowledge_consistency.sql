CREATE FUNCTION protect_knowledge_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Knowledge edits must preserve identity and audience and advance one version' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_page_guard BEFORE UPDATE ON knowledge_pages FOR EACH ROW EXECUTE FUNCTION protect_knowledge_page();

CREATE FUNCTION require_knowledge_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='knowledge_versions' THEN target=NEW.page_id; ELSE target=NEW.id; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM knowledge_pages p JOIN knowledge_versions v ON v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.version
    WHERE p.workspace_id=NEW.workspace_id AND p.id=target AND p.title=v.title AND p.body=v.body
      AND p.version=(SELECT max(h.version) FROM knowledge_versions h WHERE h.workspace_id=p.workspace_id AND h.page_id=p.id)
  ) THEN
    RAISE EXCEPTION 'A knowledge page requires a matching current revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION protect_knowledge_page(),require_knowledge_snapshot() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER knowledge_page_snapshot AFTER INSERT OR UPDATE ON knowledge_pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_snapshot();
CREATE CONSTRAINT TRIGGER knowledge_version_snapshot AFTER INSERT ON knowledge_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_knowledge_snapshot();
