ALTER TABLE agents DROP CONSTRAINT agents_runtime_check;
ALTER TABLE agents ADD CONSTRAINT agents_runtime_check CHECK(runtime IN ('external','managed'));
ALTER TABLE agents ALTER COLUMN key_hash DROP NOT NULL;
ALTER TABLE tasks ADD COLUMN conversation_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_conversation_fk FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id);
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  prompt text NOT NULL,
  instructions text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled','outcome_unknown')),
  session_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_started boolean NOT NULL DEFAULT false,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,requester_id,request_key),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,id),
  FOREIGN KEY(workspace_id,requester_id) REFERENCES memberships(workspace_id,id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX runs_pending ON agent_runs(status,created_at);
CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL,
  tool_name text NOT NULL CHECK(tool_name IN ('create_task','save_knowledge')),
  tool_version integer NOT NULL DEFAULT 1,
  parameters jsonb NOT NULL,
  action_digest text NOT NULL,
  policy_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','succeeded','cancelled','failed')),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(run_id,ordinal),
  FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,id)
);
CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  invocation_id uuid NOT NULL UNIQUE,
  approver_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  action_digest text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,invocation_id) REFERENCES tool_invocations(workspace_id,id),
  FOREIGN KEY(workspace_id,approver_id) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX invocation_pending ON tool_invocations(status,expires_at);
