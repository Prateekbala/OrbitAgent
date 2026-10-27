ALTER TABLE invitations ADD CONSTRAINT invitations_tenant_id_unique UNIQUE(workspace_id,id);
CREATE TABLE email_jobs (
 id uuid PRIMARY KEY,
 workspace_id uuid REFERENCES workspaces,
 invitation_id uuid,
 account_token_id uuid REFERENCES account_tokens,
 kind text NOT NULL CHECK(kind IN ('invitation','verify_email','reset_password')),
 ciphertext text,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 deadline timestamptz NOT NULL,
 lease_token uuid,
 lease_expires_at timestamptz,
 provider_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 FOREIGN KEY(workspace_id,invitation_id) REFERENCES invitations(workspace_id,id),
 CHECK((kind='invitation')=(invitation_id IS NOT NULL)),
 CHECK((kind='invitation')=(workspace_id IS NOT NULL)),
 CHECK((kind='invitation')=(account_token_id IS NULL))
);
CREATE INDEX email_jobs_ready ON email_jobs(available_at) WHERE status IN ('queued','sending');
CREATE INDEX email_jobs_invitation ON email_jobs(invitation_id,created_at DESC);
ALTER TABLE email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON email_jobs TO ao_identity;
CREATE POLICY identity_email_jobs ON email_jobs TO ao_identity USING(true) WITH CHECK(true);
GRANT INSERT ON email_jobs TO ao_runtime;
GRANT SELECT(id,workspace_id,invitation_id,kind,status,attempts,error_code,sent_at,created_at) ON email_jobs TO ao_runtime;
GRANT UPDATE(status,ciphertext,lease_token,lease_expires_at) ON email_jobs TO ao_runtime;
CREATE POLICY tenant_email_jobs ON email_jobs TO ao_runtime USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
