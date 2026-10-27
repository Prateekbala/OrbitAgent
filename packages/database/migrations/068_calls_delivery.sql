CREATE TABLE calls (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces, conversation_id uuid NOT NULL,
 owner_id uuid NOT NULL, client_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('no_recording','transient_captions','retained_recording')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','ending','ended')),
 room_name text NOT NULL UNIQUE, recording_state text NOT NULL DEFAULT 'off' CHECK(recording_state IN ('off','starting','recording','stopping','stopped','uncertain')),
 egress_id text, recording_key text, recording_deleted_at timestamptz, notes jsonb, notes_version integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,owner_id,client_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_id) REFERENCES memberships(workspace_id,id)
);
CREATE UNIQUE INDEX call_active_conversation ON calls(workspace_id,conversation_id) WHERE state IN ('active','ending');
CREATE INDEX call_retention ON calls(workspace_id,expires_at);
CREATE FUNCTION call_capacity_available(tenant uuid,recorded boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND count(*)<25 AND (NOT recorded OR count(*) FILTER(WHERE mode='retained_recording')<2)
 FROM public.calls WHERE workspace_id=tenant AND state IN ('active','ending')
$body$;
REVOKE ALL ON FUNCTION call_capacity_available(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION call_capacity_available(uuid,boolean) TO ao_runtime;
CREATE FUNCTION call_recording_allowed(tenant uuid,conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid AND NOT EXISTS(SELECT 1 FROM public.shared_channel_grants g WHERE g.workspace_id=tenant AND g.conversation_id=conversation AND g.state='active')
$body$;
REVOKE ALL ON FUNCTION call_recording_allowed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION call_recording_allowed(uuid,uuid) TO ao_runtime,ao_worker;
CREATE TABLE call_participants (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, call_id uuid NOT NULL, membership_id uuid NOT NULL, client_id uuid NOT NULL,
 consent boolean NOT NULL, voice_consent boolean NOT NULL DEFAULT false, auth_version integer NOT NULL, session_hash text NOT NULL,
 state text NOT NULL DEFAULT 'joined' CHECK(state IN ('joined','left','removed')),
 joined_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '60 seconds',
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,call_id,membership_id,client_id),
 FOREIGN KEY(workspace_id,call_id) REFERENCES calls(workspace_id,id), FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE call_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, call_id uuid NOT NULL, membership_id uuid NOT NULL,
 recording boolean NOT NULL, voice_agent boolean NOT NULL, action text NOT NULL CHECK(action IN ('join','withdraw','leave','remove')),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,call_id) REFERENCES calls(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE call_segments (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, call_id uuid NOT NULL, speaker_id uuid NOT NULL, client_id uuid NOT NULL,
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000), start_ms integer NOT NULL, end_ms integer NOT NULL,
 version integer NOT NULL DEFAULT 1, source text NOT NULL DEFAULT 'participant_caption' CHECK(source='participant_caption'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id), UNIQUE(workspace_id,call_id,speaker_id,client_id),
 FOREIGN KEY(workspace_id,call_id) REFERENCES calls(workspace_id,id), FOREIGN KEY(workspace_id,speaker_id) REFERENCES memberships(workspace_id,id),
 CHECK(start_ms>=0 AND end_ms>start_ms)
);
CREATE INDEX call_segments_timeline ON call_segments(workspace_id,call_id,start_ms,id);
CREATE TABLE call_segment_versions (
 workspace_id uuid NOT NULL, segment_id uuid NOT NULL, version integer NOT NULL, text text NOT NULL, editor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,segment_id,version),
 FOREIGN KEY(workspace_id,segment_id) REFERENCES call_segments(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,editor_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE notification_delivery_preferences (
 workspace_id uuid NOT NULL, membership_id uuid NOT NULL, preferences jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,membership_id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE TABLE notification_devices (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, membership_id uuid NOT NULL, client_id uuid NOT NULL,
 name text NOT NULL, platform text NOT NULL CHECK(platform IN ('browser','desktop','ios','android')),
 ciphertext text, endpoint_hash text NOT NULL, auth_version integer NOT NULL, session_hash text NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', revoked_at timestamptz,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,membership_id,client_id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
CREATE INDEX notification_device_endpoint ON notification_devices(workspace_id,endpoint_hash) WHERE revoked_at IS NULL;
CREATE TABLE notification_scope_preferences (
 workspace_id uuid NOT NULL, membership_id uuid NOT NULL, scope text NOT NULL CHECK(scope IN ('conversation','thread','agent')),
 resource_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('default','muted','high')),
 PRIMARY KEY(workspace_id,membership_id,scope,resource_id), FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id)
);
ALTER TABLE notifications ADD CONSTRAINT notifications_tenant_id UNIQUE(workspace_id,id);
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, membership_id uuid NOT NULL, notification_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN ('push','email')), device_id uuid, generation integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','received','opened','cancelled','failed','outcome_unknown')),
 available_at timestamptz NOT NULL, deadline timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_expires_at timestamptz, receipt_hash text, batch_id uuid,
 error_code text, provider_id text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 received_at timestamptz, opened_at timestamptz, UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY(workspace_id,notification_id) REFERENCES notifications(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,device_id) REFERENCES notification_devices(workspace_id,id), CHECK((channel='push')=(device_id IS NOT NULL))
);
CREATE UNIQUE INDEX notification_delivery_dedup ON notification_deliveries(workspace_id,notification_id,channel,coalesce(device_id,'00000000-0000-0000-0000-000000000000'::uuid),generation);
CREATE INDEX notification_delivery_ready ON notification_deliveries(workspace_id,available_at) WHERE state='queued';
CREATE INDEX notification_delivery_source_window ON notifications(workspace_id,created_at,sequence);
CREATE TABLE notification_delivery_plans (
 workspace_id uuid NOT NULL, notification_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,notification_id), FOREIGN KEY(workspace_id,notification_id) REFERENCES notifications(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE notification_delivery_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery_plans FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON notification_delivery_plans TO ao_worker;
CREATE POLICY worker_boundary ON notification_delivery_plans TO ao_worker USING(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid) WITH CHECK(workspace_id=nullif(current_setting('ao.workspace_id',true),'')::uuid);
DO $body$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['calls','call_participants','call_consents','call_segments','call_segment_versions','notification_delivery_preferences','notification_devices','notification_scope_preferences','notification_deliveries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_runtime,ao_worker',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO ao_runtime,ao_worker USING(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''ao.workspace_id'',true),'''')::uuid)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['notification_delivery_preferences','notification_devices','notification_scope_preferences','notification_deliveries'] LOOP
 EXECUTE format('CREATE POLICY own_delivery ON %I AS RESTRICTIVE TO ao_runtime USING(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid) WITH CHECK(membership_id=nullif(current_setting(''ao.membership_id'',true),'''')::uuid)',t);
 END LOOP;
END
$body$;
CREATE POLICY call_audience ON calls AS RESTRICTIVE TO ao_runtime USING(expires_at>now() AND resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid)) WITH CHECK(resource_visible_to(workspace_id,conversation_id,created_at,nullif(current_setting('ao.membership_id',true),'')::uuid));
CREATE POLICY call_permission ON calls AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=calls.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND coalesce((m.permissions->>'messages.read')::boolean,true))) WITH CHECK(EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=calls.workspace_id AND m.id=nullif(current_setting('ao.membership_id',true),'')::uuid AND m.status='active' AND coalesce((m.permissions->>'messages.read')::boolean,true)));
CREATE POLICY call_audience ON call_participants AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_participants.workspace_id AND c.id=call_id)) WITH CHECK(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_participants.workspace_id AND c.id=call_id));
CREATE POLICY call_audience ON call_consents AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_consents.workspace_id AND c.id=call_id)) WITH CHECK(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_consents.workspace_id AND c.id=call_id));
CREATE POLICY call_audience ON call_segments AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_segments.workspace_id AND c.id=call_id AND c.mode='retained_recording')) WITH CHECK(EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=call_segments.workspace_id AND c.id=call_id AND c.mode='retained_recording'));
CREATE POLICY call_audience ON call_segment_versions AS RESTRICTIVE TO ao_runtime USING(EXISTS(SELECT 1 FROM call_segments s WHERE s.workspace_id=call_segment_versions.workspace_id AND s.id=segment_id)) WITH CHECK(EXISTS(SELECT 1 FROM call_segments s WHERE s.workspace_id=call_segment_versions.workspace_id AND s.id=segment_id));
ALTER TABLE retained_transcripts ADD COLUMN call_id uuid;
ALTER TABLE retained_transcripts ADD CONSTRAINT transcript_call FOREIGN KEY(workspace_id,call_id) REFERENCES calls(workspace_id,id);
CREATE UNIQUE INDEX transcript_one_call ON retained_transcripts(workspace_id,call_id) WHERE call_id IS NOT NULL;
CREATE FUNCTION sync_call_transcript() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE target uuid; tenant uuid; meeting public.calls; content text;
BEGIN
 IF TG_OP='DELETE' THEN target:=OLD.call_id;tenant:=OLD.workspace_id; ELSE target:=NEW.call_id;tenant:=NEW.workspace_id; END IF;
 SELECT * INTO meeting FROM public.calls WHERE workspace_id=tenant AND id=target FOR UPDATE;
 IF meeting.mode<>'retained_recording' OR meeting.expires_at<=now() THEN DELETE FROM public.retained_transcripts WHERE workspace_id=tenant AND call_id=target; RETURN NULL; END IF;
 SELECT string_agg(m.name || ': ' || s.text,E'\n' ORDER BY s.start_ms,s.id) INTO content FROM public.call_segments s JOIN public.memberships m ON m.workspace_id=s.workspace_id AND m.id=s.speaker_id WHERE s.workspace_id=tenant AND s.call_id=target;
 IF content IS NULL THEN DELETE FROM public.retained_transcripts WHERE workspace_id=tenant AND call_id=target; RETURN NULL; END IF;
 IF length(content)>200000 THEN RAISE EXCEPTION 'Call transcript limit exceeded' USING ERRCODE='22001'; END IF;
 INSERT INTO public.retained_transcripts(id,workspace_id,conversation_id,owner_id,client_id,call_id,title,body,language,consent_reference,retained_until,created_at)
 VALUES(target,tenant,meeting.conversation_id,meeting.owner_id,target,target,'Call transcript · ' || to_char(meeting.created_at,'YYYY-MM-DD'),content,'und','call-consent-ledger:'||target::text,meeting.expires_at,meeting.created_at)
 ON CONFLICT(workspace_id,call_id) WHERE call_id IS NOT NULL DO UPDATE SET body=EXCLUDED.body,version=public.retained_transcripts.version+1;
 RETURN NULL;
END
$body$;
CREATE TRIGGER call_transcript_index AFTER INSERT OR UPDATE OR DELETE ON call_segments FOR EACH ROW EXECUTE FUNCTION sync_call_transcript();
CREATE POLICY linked_call_retention ON retained_transcripts AS RESTRICTIVE TO ao_runtime USING(call_id IS NULL OR EXISTS(SELECT 1 FROM calls c WHERE c.workspace_id=retained_transcripts.workspace_id AND c.id=call_id AND c.expires_at>now()));
CREATE FUNCTION expire_call_content(tenant uuid,target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE member uuid:=nullif(current_setting('ao.membership_id',true),'')::uuid;
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR NOT EXISTS(
 SELECT 1 FROM public.calls c JOIN public.memberships m ON m.workspace_id=c.workspace_id AND m.id=member
 WHERE c.workspace_id=tenant AND c.id=target AND m.kind='human' AND m.status='active'
 AND (c.owner_id=member OR m.role IN ('owner','admin')) AND coalesce((m.permissions->>'messages.read')::boolean,true)
 AND coalesce((m.permissions->>'messages.write')::boolean,true)
 AND public.resource_visible_to(tenant,c.conversation_id,c.created_at,member)) THEN RAISE EXCEPTION 'Call content deletion denied' USING ERRCODE='42501'; END IF;
 DELETE FROM public.retained_transcripts WHERE workspace_id=tenant AND call_id=target;
 UPDATE public.calls SET expires_at=now(),notes=NULL,state=CASE WHEN state='active' THEN 'ending' ELSE state END WHERE workspace_id=tenant AND id=target;
END
$body$;
REVOKE ALL ON FUNCTION expire_call_content(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_call_content(uuid,uuid) TO ao_runtime;
REVOKE UPDATE,DELETE ON call_consents FROM ao_runtime;
REVOKE UPDATE ON call_segment_versions FROM ao_runtime;
