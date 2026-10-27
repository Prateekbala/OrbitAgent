CREATE TABLE shared_rate_limits(key_hash text PRIMARY KEY CHECK(length(key_hash)=64),counter integer NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX shared_rate_expiry ON shared_rate_limits(expires_at);
ALTER TABLE shared_rate_limits ENABLE ROW LEVEL SECURITY;ALTER TABLE shared_rate_limits FORCE ROW LEVEL SECURITY;
CREATE FUNCTION consume_rate_limit(key text,window_ms integer) RETURNS TABLE(current integer,ttl integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE row public.shared_rate_limits;BEGIN
 IF key!~'^[a-f0-9]{64}$' OR window_ms NOT BETWEEN 1000 AND 3600000 THEN RAISE EXCEPTION 'Invalid limiter parameters';END IF;
 INSERT INTO public.shared_rate_limits VALUES(key,1,clock_timestamp()+window_ms*interval '1 millisecond') ON CONFLICT(key_hash) DO UPDATE SET counter=CASE WHEN shared_rate_limits.expires_at<=clock_timestamp() THEN 1 ELSE least(shared_rate_limits.counter+1,1000000000) END,expires_at=CASE WHEN shared_rate_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+window_ms*interval '1 millisecond' ELSE shared_rate_limits.expires_at END RETURNING * INTO row;
 RETURN QUERY SELECT row.counter,greatest(1,ceil(extract(epoch FROM row.expires_at-clock_timestamp())*1000)::integer);
END $body$;
CREATE TABLE operation_metrics(route text NOT NULL,status integer NOT NULL,requests bigint NOT NULL DEFAULT 0,duration_ms bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(route,status));
ALTER TABLE operation_metrics ENABLE ROW LEVEL SECURITY;ALTER TABLE operation_metrics FORCE ROW LEVEL SECURITY;
CREATE FUNCTION record_operation_metrics(batch jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE item jsonb;BEGIN
 IF jsonb_array_length(batch)>1000 THEN RAISE EXCEPTION 'Metric batch too large';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(batch) LOOP
  IF length(item->>'route')>200 OR (item->>'status')::int NOT BETWEEN 100 AND 599 OR (item->>'requests')::bigint NOT BETWEEN 1 AND 1000000 OR (item->>'duration')::bigint NOT BETWEEN 0 AND 100000000000 THEN RAISE EXCEPTION 'Invalid metric';END IF;
  INSERT INTO public.operation_metrics(route,status,requests,duration_ms) VALUES(item->>'route',(item->>'status')::int,(item->>'requests')::bigint,(item->>'duration')::bigint) ON CONFLICT(route,status) DO UPDATE SET requests=operation_metrics.requests+EXCLUDED.requests,duration_ms=operation_metrics.duration_ms+EXCLUDED.duration_ms,updated_at=now();
 END LOOP;
 DELETE FROM public.shared_rate_limits WHERE key_hash IN(SELECT key_hash FROM public.shared_rate_limits WHERE expires_at<now()-interval '1 hour' LIMIT 1000);
END $body$;
CREATE FUNCTION operation_metrics_snapshot() RETURNS TABLE(route text,status integer,requests text,duration_ms text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT route,status,requests::text,duration_ms::text FROM public.operation_metrics $body$;
REVOKE ALL ON FUNCTION consume_rate_limit(text,integer),record_operation_metrics(jsonb),operation_metrics_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_rate_limit(text,integer),record_operation_metrics(jsonb),operation_metrics_snapshot() TO ao_runtime;
CREATE TABLE public_incidents(id uuid PRIMARY KEY,title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200),status text NOT NULL CHECK(status IN ('investigating','identified','monitoring','resolved')),description text NOT NULL CHECK(length(description)<=5000),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public_incidents ENABLE ROW LEVEL SECURITY;ALTER TABLE public_incidents FORCE ROW LEVEL SECURITY;
CREATE FUNCTION published_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'state',s.status,'message',s.description,'updatedAt',s.updated_at)),'[]') FROM(SELECT id,title,status,description,updated_at FROM public.public_incidents ORDER BY updated_at DESC LIMIT 20)s $body$;
REVOKE ALL ON FUNCTION published_status() FROM PUBLIC;GRANT EXECUTE ON FUNCTION published_status() TO ao_runtime;
CREATE TABLE product_metrics(organization_id uuid NOT NULL REFERENCES organizations,day date NOT NULL,event text NOT NULL,total bigint NOT NULL DEFAULT 0,PRIMARY KEY(organization_id,day,event));
ALTER TABLE product_metrics ENABLE ROW LEVEL SECURITY;ALTER TABLE product_metrics FORCE ROW LEVEL SECURITY;GRANT SELECT ON product_metrics TO ao_identity;CREATE POLICY product_identity ON product_metrics TO ao_identity USING(true);
CREATE FUNCTION count_product_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE org uuid;BEGIN
 IF NEW.action NOT IN ('task.transitioned','run.completed','approval.approved','approval.rejected','knowledge.published','message.created') THEN RETURN NULL;END IF;
 SELECT w.organization_id INTO org FROM public.workspaces w JOIN public.governance_policies p ON p.organization_id=w.organization_id WHERE w.id=NEW.workspace_id AND (p.policy->>'analytics')::boolean;
 IF org IS NOT NULL THEN INSERT INTO public.product_metrics VALUES(org,current_date,NEW.action,1) ON CONFLICT(organization_id,day,event) DO UPDATE SET total=product_metrics.total+1;END IF;RETURN NULL;
END $body$;
CREATE TRIGGER product_outcome AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION count_product_outcome();
CREATE FUNCTION operations_queues(org uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT jsonb_build_object('developer',coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM(SELECT d.state,count(*) total,min(d.created_at) oldest FROM public.developer_deliveries d JOIN public.workspaces w ON w.id=d.workspace_id WHERE w.organization_id=org GROUP BY d.state)q),'[]'),'connections',coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM(SELECT d.state,count(*) total,min(d.created_at) oldest FROM public.connection_events d JOIN public.workspaces w ON w.id=d.workspace_id WHERE w.organization_id=org GROUP BY d.state)q),'[]'),'retrieval',coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM(SELECT d.state,count(*) total,min(d.updated_at) oldest FROM public.retrieval_jobs d JOIN public.workspaces w ON w.id=d.workspace_id WHERE w.organization_id=org GROUP BY d.state)q),'[]'))
$body$;
CREATE FUNCTION replay_delivery(org uuid,workspace uuid,kind text,target uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE changed integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE organization_id=org AND id=workspace) THEN RETURN false;END IF;
 IF kind='developer' THEN UPDATE public.developer_deliveries SET state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_expires_at=NULL,error_code=NULL WHERE workspace_id=workspace AND id=target AND state='dead';
 ELSIF kind='connection' THEN UPDATE public.connection_events SET state='pending',attempts=0,available_at=now(),lease=NULL,lease_until=NULL,error_code=NULL WHERE workspace_id=workspace AND id=target AND state='dead';
 ELSE RETURN false;END IF;GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed=1;
END $body$;
REVOKE ALL ON FUNCTION operations_queues(uuid),replay_delivery(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations_queues(uuid),replay_delivery(uuid,uuid,text,uuid) TO ao_identity;

CREATE TABLE operation_replays(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,workspace_id uuid NOT NULL REFERENCES workspaces,delivery_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('developer','connection')),actor_id uuid NOT NULL REFERENCES accounts,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE operation_replays ENABLE ROW LEVEL SECURITY;ALTER TABLE operation_replays FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON operation_replays TO ao_identity;
CREATE POLICY replay_identity ON operation_replays TO ao_identity USING(true) WITH CHECK(true);
CREATE TRIGGER immutable_security_record BEFORE UPDATE OR DELETE ON operation_replays FOR EACH ROW EXECUTE FUNCTION immutable_security_record();
