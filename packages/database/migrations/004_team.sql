ALTER TABLE memberships ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended'));
ALTER TABLE memberships ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE knowledge_pages ADD CONSTRAINT knowledge_pages_tenant_unique UNIQUE(workspace_id,id);
ALTER TABLE knowledge_versions ADD COLUMN workspace_id uuid;
UPDATE knowledge_versions v SET workspace_id=p.workspace_id FROM knowledge_pages p WHERE p.id=v.page_id;
ALTER TABLE knowledge_versions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_tenant_page_fk FOREIGN KEY(workspace_id,page_id) REFERENCES knowledge_pages(workspace_id,id);
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_tenant_author_fk FOREIGN KEY(workspace_id,author_id) REFERENCES memberships(workspace_id,id);
CREATE TABLE invitations (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces,
 email text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','member')),
 token_hash text NOT NULL UNIQUE,
 inviter_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 accepted_by uuid REFERENCES accounts,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,inviter_id) REFERENCES memberships(workspace_id,id)
);
CREATE UNIQUE INDEX invitations_pending ON invitations(workspace_id,email) WHERE status='pending';
