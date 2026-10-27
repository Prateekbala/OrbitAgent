ALTER TABLE tool_actions ADD COLUMN encrypted_capability text;
CREATE OR REPLACE FUNCTION protect_tool_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.invocation_id,NEW.idempotency_key,NEW.capability_hash,NEW.capability_expires_at,NEW.encrypted_capability) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.invocation_id,OLD.idempotency_key,OLD.capability_hash,OLD.capability_expires_at,OLD.encrypted_capability)
 OR OLD.state IN ('succeeded','failed') OR OLD.state='outcome_unknown' AND NEW.state='dispatched' THEN
 RAISE EXCEPTION 'Action identity and terminal outcomes are immutable; uncertain actions cannot be replayed' USING ERRCODE='23514'; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW; END $$;
UPDATE tool_actions SET state='failed',error_code='CAPABILITY_REISSUE_REQUIRED' WHERE state='prepared' AND encrypted_capability IS NULL;
UPDATE tool_invocations i SET status='failed',error_code='CAPABILITY_REISSUE_REQUIRED' WHERE i.status='executing' AND EXISTS(SELECT 1 FROM tool_actions a WHERE a.workspace_id=i.workspace_id AND a.invocation_id=i.id AND a.error_code='CAPABILITY_REISSUE_REQUIRED');
