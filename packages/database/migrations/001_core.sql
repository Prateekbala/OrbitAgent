CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  account_id uuid REFERENCES accounts,
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('human','agent')),
  role text NOT NULL CHECK(role IN ('owner','admin','member')),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,account_id),
  CHECK((kind='human')=(account_id IS NOT NULL))
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts,
  membership_id uuid NOT NULL REFERENCES memberships,
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL CHECK(visibility IN ('public','private')),
  next_sequence integer NOT NULL DEFAULT 0,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,name)
);

CREATE TABLE conversation_members (
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,conversation_id,membership_id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 12000),
  client_id uuid NOT NULL,
  thread_id uuid,
  sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,conversation_id,id),
  UNIQUE(workspace_id,conversation_id,sequence),
  UNIQUE(workspace_id,author_id,client_id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY(workspace_id,author_id) REFERENCES memberships(workspace_id,id),
  FOREIGN KEY(workspace_id,conversation_id,thread_id) REFERENCES messages(workspace_id,conversation_id,id)
);

CREATE INDEX messages_timeline ON messages(workspace_id,conversation_id,sequence DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  title text NOT NULL,
  description text NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','queued','active','blocked','awaiting_approval','awaiting_review','completed','failed','cancelled')),
  priority text NOT NULL CHECK(priority IN ('low','normal','high')),
  assignee_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,assignee_id) REFERENCES memberships(workspace_id,id)
);

CREATE INDEX tasks_workspace ON tasks(workspace_id,state);

CREATE TABLE task_transitions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks,
  actor_id uuid NOT NULL,
  evidence text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id)
);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  instructions text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  runtime text NOT NULL DEFAULT 'external' CHECK(runtime='external'),
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);

CREATE TABLE agent_inbox (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  message_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,message_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id),
  FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id)
);

CREATE TABLE knowledge_pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  conversation_id uuid,
  title text NOT NULL,
  body text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  author_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  FOREIGN KEY(workspace_id,author_id) REFERENCES memberships(workspace_id,id)
);

CREATE TABLE knowledge_versions (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES knowledge_pages,
  title text NOT NULL,
  body text NOT NULL,
  version integer NOT NULL,
  author_id uuid NOT NULL REFERENCES memberships,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(page_id,version)
);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  event_type text NOT NULL,
  resource_id uuid NOT NULL,
  conversation_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);

CREATE INDEX outbox_workspace ON outbox_events(workspace_id,id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id)
);
