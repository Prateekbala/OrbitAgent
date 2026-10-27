CREATE INDEX messages_search_live ON messages USING gin(to_tsvector('english',body)) WHERE deleted_at IS NULL;
CREATE INDEX messages_search_workspace_date ON messages(workspace_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_search ON knowledge_pages USING gin(to_tsvector('english',title || ' ' || body));
CREATE INDEX knowledge_search_workspace_date ON knowledge_pages(workspace_id,updated_at DESC,id DESC);
CREATE INDEX knowledge_versions_timeline ON knowledge_versions(workspace_id,page_id,version DESC);

ALTER TABLE knowledge_versions ADD COLUMN summary text NOT NULL DEFAULT '' CHECK(length(summary)<=500);
ALTER TABLE knowledge_versions ADD COLUMN restored_from integer;
ALTER TABLE knowledge_versions ADD COLUMN request_id uuid;
ALTER TABLE knowledge_versions ADD COLUMN request_hash text;
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_revision_request UNIQUE(workspace_id,page_id,request_id);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_restore_source FOREIGN KEY(page_id,restored_from) REFERENCES knowledge_versions(page_id,version);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_version_positive CHECK(version>0);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_request_pair CHECK((request_id IS NULL)=(request_hash IS NULL));
ALTER TABLE knowledge_pages ADD CONSTRAINT knowledge_page_version_positive CHECK(version>0);

REVOKE UPDATE,DELETE ON knowledge_versions FROM ao_runtime,ao_worker;
CREATE FUNCTION protect_knowledge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Knowledge revisions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER knowledge_revision_immutable BEFORE UPDATE OR DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION protect_knowledge_revision();
