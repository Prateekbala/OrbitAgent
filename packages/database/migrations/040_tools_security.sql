ALTER TABLE tool_invocations DROP CONSTRAINT tool_invocations_tool_name_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_tool_name_check CHECK(tool_name IN ('create_task','save_knowledge','delegate_agent','read_tasks','read_knowledge','connection_action','execute_code','interactive_form'));
ALTER TABLE tool_invocations DROP CONSTRAINT tool_invocations_status_check;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_status_check CHECK(status IN ('pending','approved','rejected','expired','succeeded','cancelled','failed','executing','outcome_unknown'));
ALTER TABLE tool_invocations ADD COLUMN authorization_snapshot jsonb NOT NULL DEFAULT '{}';
CREATE TABLE tool_policies (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), version integer NOT NULL DEFAULT 1,
 rules jsonb NOT NULL DEFAULT '{}', updated_by uuid,
 FOREIGN KEY(workspace_id,updated_by) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE tool_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, owner_id uuid NOT NULL,
 name text NOT NULL, endpoint text NOT NULL, operations jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE tool_connection_secrets (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, encrypted_secret text NOT NULL,
 PRIMARY KEY(workspace_id,connection_id), FOREIGN KEY(workspace_id,connection_id) REFERENCES tool_connections(workspace_id,id)
);
CREATE TABLE tool_connection_grants (
 workspace_id uuid NOT NULL, connection_id uuid NOT NULL, member_id uuid NOT NULL,
 operations text[] NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 PRIMARY KEY(workspace_id,connection_id,member_id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES tool_connections(workspace_id,id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE tool_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, invocation_id uuid NOT NULL,
 idempotency_key uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','dispatched','succeeded','failed','outcome_unknown')),
 capability_hash text NOT NULL, capability_expires_at timestamptz NOT NULL, consumed_at timestamptz,
 result jsonb, error_code text, receipt text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,invocation_id), UNIQUE(idempotency_key),
 FOREIGN KEY(workspace_id,invocation_id) REFERENCES tool_invocations(workspace_id,id)
);
CREATE TABLE tool_action_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, workspace_id uuid NOT NULL, action_id uuid NOT NULL,
 state text NOT NULL, actor_id uuid, receipt text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,action_id) REFERENCES tool_actions(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE tool_forms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 invocation_id uuid NOT NULL, title text NOT NULL, description text NOT NULL, fields jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,invocation_id),
 FOREIGN KEY(workspace_id,invocation_id) REFERENCES tool_invocations(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE TABLE tool_form_submissions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, form_id uuid NOT NULL, member_id uuid NOT NULL,
 values jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,form_id,member_id),
 FOREIGN KEY(workspace_id,form_id) REFERENCES tool_forms(workspace_id,id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES memberships(workspace_id,id)
);
CREATE FUNCTION tool_connection_access(tenant uuid, connection uuid, owner_only boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM public.tool_connections c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid
 WHERE c.workspace_id=tenant AND c.id=connection AND m.status='active' AND m.access_type='member' AND
 (c.owner_id=m.id OR (NOT owner_only AND EXISTS(SELECT 1 FROM public.tool_connection_grants g WHERE g.workspace_id=c.workspace_id AND g.connection_id=c.id AND g.member_id=m.id AND g.revoked_at IS NULL AND g.expires_at>now()))))
$$;
REVOKE ALL ON FUNCTION tool_connection_access(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tool_connection_access(uuid,uuid,boolean) TO ao_runtime,ao_worker;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['tool_policies','tool_connections','tool_connection_secrets','tool_connection_grants','tool_actions','tool_action_events','tool_forms','tool_form_submissions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',name);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
GRANT USAGE ON SEQUENCE tool_action_events_id_seq TO ao_runtime,ao_worker;
CREATE POLICY connection_visibility ON tool_connections AS RESTRICTIVE FOR SELECT TO ao_runtime USING(tool_connection_access(workspace_id,id));
CREATE POLICY connection_secrets ON tool_connection_secrets AS RESTRICTIVE TO ao_runtime USING(tool_connection_access(workspace_id,connection_id,true)) WITH CHECK(tool_connection_access(workspace_id,connection_id,true));
CREATE POLICY grant_visibility ON tool_connection_grants AS RESTRICTIVE TO ao_runtime USING(tool_connection_access(workspace_id,connection_id,true) OR member_id=nullif(current_setting('ao.membership_id',true),'')::uuid) WITH CHECK(tool_connection_access(workspace_id,connection_id,true));
CREATE POLICY action_visibility ON tool_actions AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM tool_invocations i JOIN agent_runs r ON r.workspace_id=i.workspace_id AND r.id=i.run_id WHERE i.workspace_id=tool_actions.workspace_id AND i.id=invocation_id));
CREATE POLICY action_event_visibility ON tool_action_events AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM tool_actions a WHERE a.workspace_id=tool_action_events.workspace_id AND a.id=action_id));
CREATE POLICY form_visibility ON tool_forms AS RESTRICTIVE TO ao_runtime USING(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid) AND agent_credential_allows(conversation_id));
CREATE POLICY submission_visibility ON tool_form_submissions AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM tool_forms f WHERE f.workspace_id=tool_form_submissions.workspace_id AND f.id=form_id) AND member_id=nullif(current_setting('ao.membership_id',true),'')::uuid);
CREATE FUNCTION protect_tool_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.invocation_id,NEW.idempotency_key,NEW.capability_hash,NEW.capability_expires_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.invocation_id,OLD.idempotency_key,OLD.capability_hash,OLD.capability_expires_at)
 OR OLD.state IN ('succeeded','failed') OR OLD.state='outcome_unknown' AND NEW.state='dispatched' THEN
 RAISE EXCEPTION 'Action identity and terminal outcomes are immutable; uncertain actions cannot be replayed' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER tool_action_guard BEFORE UPDATE ON tool_actions FOR EACH ROW EXECUTE FUNCTION protect_tool_action();
CREATE FUNCTION record_tool_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO tool_action_events(workspace_id,action_id,state,receipt) VALUES(NEW.workspace_id,NEW.id,NEW.state,NEW.receipt); RETURN NEW; END $$;
CREATE TRIGGER tool_action_audit AFTER INSERT OR UPDATE OF state ON tool_actions FOR EACH ROW EXECUTE FUNCTION record_tool_action();
CREATE FUNCTION immutable_tool_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Action events are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER tool_event_guard BEFORE UPDATE OR DELETE ON tool_action_events FOR EACH ROW EXECUTE FUNCTION immutable_tool_event();
REVOKE UPDATE,DELETE ON tool_action_events FROM ao_runtime,ao_worker;
REVOKE ALL ON FUNCTION protect_tool_action(),record_tool_action(),immutable_tool_event() FROM PUBLIC;
