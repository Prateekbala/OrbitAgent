ALTER TABLE agents ADD COLUMN owner_id uuid;
ALTER TABLE agents ADD COLUMN credential_issuer_id uuid;
ALTER TABLE agents ADD CONSTRAINT agent_owner FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id);
ALTER TABLE agents ADD CONSTRAINT agent_credential_issuer FOREIGN KEY(workspace_id,credential_issuer_id) REFERENCES memberships(workspace_id,id);
UPDATE agents a SET owner_id=e.actor_id,credential_issuer_id=e.actor_id
 FROM (SELECT DISTINCT ON (workspace_id,resource_id) workspace_id,resource_id,actor_id FROM audit_events WHERE action='agent.created' ORDER BY workspace_id,resource_id,created_at,id) e
 WHERE a.workspace_id=e.workspace_id AND a.id=e.resource_id;
CREATE INDEX agents_owner ON agents(workspace_id,owner_id);
CREATE INDEX agents_credential_issuer ON agents(workspace_id,credential_issuer_id);
CREATE TABLE organizations (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80),
 allowed_domains text[] NOT NULL DEFAULT '{}',
 allowed_regions text[] NOT NULL DEFAULT '{global}',
 require_mfa boolean NOT NULL DEFAULT false,
 require_sso boolean NOT NULL DEFAULT false,
 session_hours integer NOT NULL DEFAULT 168 CHECK(session_hours BETWEEN 1 AND 168),
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organizations(id,name) SELECT id,name FROM workspaces;
ALTER TABLE workspaces ADD COLUMN organization_id uuid REFERENCES organizations;
UPDATE workspaces SET organization_id=id;
ALTER TABLE workspaces ADD COLUMN region text NOT NULL DEFAULT 'global';
ALTER TABLE workspaces ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX workspaces_organization ON workspaces(organization_id);
ALTER TABLE workspaces ADD CONSTRAINT workspace_organization_id_unique UNIQUE(organization_id,id);
ALTER TABLE workspaces ADD CONSTRAINT workspace_region CHECK(region IN ('global','us','eu','in','ap'));
CREATE TABLE organization_members (
 organization_id uuid NOT NULL REFERENCES organizations,
 account_id uuid NOT NULL REFERENCES accounts,
 role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 external_id text,
 display_name text,
 provisioned boolean NOT NULL DEFAULT false,
 scim_deleted_at timestamptz,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,account_id),
 UNIQUE(organization_id,external_id)
);
INSERT INTO organization_members(organization_id,account_id,role,status)
 SELECT workspace_id,account_id,role,status FROM memberships WHERE kind='human';
CREATE TABLE organization_domains (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations,
 domain text NOT NULL UNIQUE,
 verification_hash text NOT NULL,
 verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE organization_audit (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations,
 actor_id uuid REFERENCES accounts,
 action text NOT NULL,
 resource_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_audit_timeline ON organization_audit(organization_id,created_at DESC,id);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_identity ON organizations TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON organizations TO ao_identity;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_member_identity ON organization_members TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON organization_members TO ao_identity;
ALTER TABLE organization_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY domain_identity ON organization_domains TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON organization_domains TO ao_identity;
ALTER TABLE organization_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_audit_identity ON organization_audit TO ao_identity USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON organization_audit TO ao_identity;

CREATE FUNCTION seed_workspace_organization() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF NEW.organization_id IS NULL THEN
  INSERT INTO organizations(id,name,allowed_regions) VALUES(NEW.id,NEW.name,ARRAY[NEW.region]);
  NEW.organization_id:=NEW.id;
 END IF;
 RETURN NEW;
END
$body$;
CREATE TRIGGER workspace_organization BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION seed_workspace_organization();
CREATE FUNCTION guard_workspace_organization() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF (NEW.organization_id,NEW.region) IS DISTINCT FROM (OLD.organization_id,OLD.region) THEN
  RAISE EXCEPTION 'Workspace organization and data region are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END
$body$;
CREATE TRIGGER guard_workspace_organization BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION guard_workspace_organization();
CREATE FUNCTION enroll_organization_member() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE org uuid;
BEGIN
 IF NEW.kind='human' THEN
  SELECT organization_id INTO org FROM workspaces WHERE id=NEW.workspace_id;
  IF NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org AND account_id=NEW.account_id) THEN
  INSERT INTO organization_members(organization_id,account_id,role)
   VALUES(org,NEW.account_id,CASE WHEN NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM organization_members WHERE organization_id=org) THEN 'owner' ELSE 'member' END)
   ON CONFLICT(organization_id,account_id) DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END
$body$;
CREATE TRIGGER membership_organization AFTER INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION enroll_organization_member();

ALTER TABLE memberships ADD COLUMN access_type text NOT NULL DEFAULT 'member' CHECK(access_type IN ('member','guest','service'));
ALTER TABLE memberships ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}';
ALTER TABLE memberships ADD COLUMN offboarded_at timestamptz;
ALTER TABLE memberships ADD COLUMN provisioned boolean NOT NULL DEFAULT false;
ALTER TABLE memberships ADD CONSTRAINT restricted_membership_role CHECK(access_type='member' OR role='member');
ALTER TABLE memberships ADD CONSTRAINT service_membership_kind CHECK(access_type<>'service' OR kind='agent');
ALTER TABLE invitations ADD COLUMN access_type text NOT NULL DEFAULT 'member' CHECK(access_type IN ('member','guest'));
ALTER TABLE invitations ADD COLUMN conversation_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE accounts ADD COLUMN avatar_url text;
ALTER TABLE accounts ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';
ALTER TABLE accounts ADD COLUMN locale text NOT NULL DEFAULT 'en';
ALTER TABLE accounts ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN disabled_at timestamptz;
ALTER TABLE accounts ADD COLUMN managed_organization_id uuid REFERENCES organizations;
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN user_agent text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN ip_address text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
ALTER TABLE sessions ADD COLUMN authentication_method text NOT NULL DEFAULT 'password' CHECK(authentication_method IN ('password','oidc','saml'));
ALTER TABLE sessions ADD COLUMN provider_id uuid;
ALTER TABLE sessions ALTER COLUMN membership_id DROP NOT NULL;
ALTER TABLE sessions ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT session_workspace_selection CHECK((membership_id IS NULL)=(workspace_id IS NULL));
ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check CHECK(purpose IN ('verify_email','reset_password','change_email'));
ALTER TABLE account_tokens ADD COLUMN target_email text;
ALTER TABLE email_jobs DROP CONSTRAINT email_jobs_kind_check;
ALTER TABLE email_jobs ADD CONSTRAINT email_jobs_kind_check CHECK(kind IN ('invitation','verify_email','reset_password','change_email'));
CREATE TABLE account_mfa (
 account_id uuid PRIMARY KEY REFERENCES accounts,
 secret text NOT NULL,
 confirmed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 last_step bigint NOT NULL DEFAULT -1,
 recovery_hashes text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE authentication_challenges (
 token_hash text PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts,
 membership_id uuid REFERENCES memberships,
 auth_version integer NOT NULL,
 method text NOT NULL DEFAULT 'password',
 provider_id uuid,
 attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE identity_providers (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations,
 workspace_id uuid NOT NULL,
 name text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('oidc','saml')),
 configuration jsonb NOT NULL,
 secret text,
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id),
 CHECK(configuration->>'workspaceId'=workspace_id::text)
);
CREATE TABLE federated_identities (
 provider_id uuid NOT NULL REFERENCES identity_providers,
 subject text NOT NULL,
 account_id uuid NOT NULL REFERENCES accounts,
 PRIMARY KEY(provider_id,subject),
 UNIQUE(provider_id,account_id)
);
CREATE TABLE federation_transactions (
 token_hash text PRIMARY KEY,
 browser_hash text NOT NULL,
 provider_id uuid NOT NULL REFERENCES identity_providers,
 verifier text NOT NULL,
 nonce text NOT NULL,
 account_id uuid REFERENCES accounts,
 session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
 CHECK((account_id IS NULL)=(session_id IS NULL)),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE saml_request_ids (
 id text PRIMARY KEY,
 provider_id uuid NOT NULL REFERENCES identity_providers,
 state_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_credentials (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 created_by uuid NOT NULL,
 token_hash text NOT NULL UNIQUE,
 label text NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE scim_credentials (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations,
 created_by uuid NOT NULL,
 token_hash text NOT NULL UNIQUE,
 label text NOT NULL,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,created_by) REFERENCES organization_members(organization_id,account_id)
);
CREATE TABLE scim_groups (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations,
 display_name text NOT NULL,
 external_id text,
 workspace_id uuid,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,external_id),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id)
);
CREATE TABLE scim_group_members (
 organization_id uuid NOT NULL,
 group_id uuid NOT NULL,
 account_id uuid NOT NULL,
 PRIMARY KEY(organization_id,group_id,account_id),
 FOREIGN KEY(organization_id,group_id) REFERENCES scim_groups(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES organization_members(organization_id,account_id)
);
ALTER TABLE organization_audit ADD COLUMN credential_id uuid;
ALTER TABLE organization_audit ADD CONSTRAINT audit_scim_credential FOREIGN KEY(organization_id,credential_id) REFERENCES scim_credentials(organization_id,id);
DO $tables$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['account_mfa','authentication_challenges','identity_providers','federated_identities','federation_transactions','saml_request_ids','service_credentials','scim_credentials','scim_groups','scim_group_members'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_identity',name);
  EXECUTE format('CREATE POLICY identity_boundary ON %I TO ao_identity USING(true) WITH CHECK(true)',name);
 END LOOP;
END
$tables$;

CREATE FUNCTION restricted_principal() RETURNS boolean LANGUAGE sql STABLE AS $body$
 SELECT coalesce(current_setting('ao.access_type',true),'') IN ('guest','service')
$body$;
CREATE FUNCTION shared_conversation(conversation uuid) RETURNS boolean LANGUAGE sql STABLE AS $body$
 SELECT EXISTS(SELECT 1 FROM conversation_members WHERE conversation_id=conversation AND membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid)
$body$;
CREATE POLICY restricted_audience ON conversations AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR shared_conversation(id)) WITH CHECK(NOT restricted_principal() OR shared_conversation(id));
DO $audiences$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['messages','tasks','knowledge_pages','files','projects','agent_runs','audit_events'] LOOP
  EXECUTE format('CREATE POLICY restricted_audience ON %I AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR shared_conversation(conversation_id)) WITH CHECK(NOT restricted_principal() OR shared_conversation(conversation_id))',name);
 END LOOP;
END
$audiences$;
CREATE POLICY restricted_audience ON outbox_events AS RESTRICTIVE TO ao_runtime
 USING(NOT restricted_principal() OR shared_conversation(conversation_id) OR audience_membership_id=nullif(current_setting('ao.membership_id',true),'')::uuid)
 WITH CHECK(NOT restricted_principal() OR shared_conversation(conversation_id) OR event_type='notification.created');
CREATE POLICY restricted_audience ON knowledge_versions AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM knowledge_pages p WHERE p.id=page_id));
CREATE POLICY restricted_audience ON task_comments AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_transitions AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_dependencies AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR (EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id) AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=depends_on_id)));
CREATE POLICY restricted_audience ON task_attachments AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_recurrences AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_reminders AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_occurrences AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_reminder_deliveries AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON task_label_links AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM tasks t WHERE t.id=task_id));
CREATE POLICY restricted_audience ON message_attachments AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR shared_conversation(conversation_id));
CREATE POLICY restricted_audience ON project_milestones AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM projects p WHERE p.id=project_id));
CREATE POLICY restricted_audience ON tool_invocations AS RESTRICTIVE TO ao_runtime USING(NOT restricted_principal() OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=run_id));

CREATE INDEX organization_account_access ON organization_members(account_id,organization_id) WHERE status='active';
CREATE INDEX membership_account_access ON memberships(account_id,status,workspace_id);
CREATE INDEX account_session_devices ON sessions(account_id,created_at DESC);
CREATE INDEX account_security_timeline ON account_security_events(account_id,created_at DESC,id);
CREATE INDEX authentication_challenge_expiry ON authentication_challenges(expires_at);
CREATE INDEX federation_transaction_expiry ON federation_transactions(expires_at);
CREATE INDEX federation_transaction_session ON federation_transactions(session_id);
CREATE INDEX federated_account_connections ON federated_identities(account_id,provider_id);
CREATE INDEX saml_request_expiry ON saml_request_ids(created_at);
CREATE INDEX mfa_pending_expiry ON account_mfa(expires_at) WHERE confirmed_at IS NULL;
CREATE INDEX service_credential_owner ON service_credentials(workspace_id,created_by);
CREATE INDEX scim_directory_account ON scim_group_members(organization_id,account_id);
