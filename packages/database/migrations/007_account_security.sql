ALTER TABLE accounts ADD COLUMN email_verified_at timestamptz;
ALTER TABLE accounts ADD COLUMN auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN auth_version integer NOT NULL DEFAULT 1;

CREATE TABLE account_tokens (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts,
 purpose text NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_tokens_open ON account_tokens(account_id,purpose) WHERE consumed_at IS NULL;
CREATE INDEX account_tokens_expiry ON account_tokens(expires_at);
ALTER TABLE account_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_tokens FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON account_tokens TO ao_identity;
CREATE POLICY identity_tokens ON account_tokens TO ao_identity USING(true) WITH CHECK(true);

CREATE TABLE account_security_events (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts,
 event_type text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_security_events FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON account_security_events TO ao_identity;
CREATE POLICY identity_security_events ON account_security_events TO ao_identity USING(true) WITH CHECK(true);
