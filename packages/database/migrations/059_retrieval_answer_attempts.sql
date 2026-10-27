CREATE TABLE retrieval_answer_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, member_id uuid NOT NULL,
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 150), input_bytes integer NOT NULL CHECK(input_bytes BETWEEN 1 AND 32000),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','succeeded','failed')),
 lease_until timestamptz NOT NULL DEFAULT now()+interval '45 seconds', created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX answer_usage ON retrieval_answer_attempts(workspace_id,created_at,member_id);
ALTER TABLE retrieval_answer_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval_answer_attempts FORCE ROW LEVEL SECURITY;
GRANT SELECT ON retrieval_answer_attempts TO ao_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON retrieval_answer_attempts TO ao_worker;
CREATE POLICY tenant_boundary ON retrieval_answer_attempts TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
CREATE POLICY attempt_owner ON retrieval_answer_attempts AS RESTRICTIVE TO ao_runtime USING(member_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
