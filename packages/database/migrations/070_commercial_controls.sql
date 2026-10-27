CREATE TABLE commercial_configuration(id boolean PRIMARY KEY DEFAULT true CHECK(id),mode text NOT NULL CHECK(mode IN ('self_hosted','managed')));
INSERT INTO commercial_configuration VALUES(true,'self_hosted');
CREATE TABLE billing_plans (
 id text NOT NULL,revision integer NOT NULL,name text NOT NULL,human_seats integer NOT NULL,allowances jsonb NOT NULL,features jsonb NOT NULL,
 PRIMARY KEY(id,revision)
);
INSERT INTO billing_plans VALUES
 ('free',1,'Free',3,'{"models":100000,"tools":1000,"runtime":3600,"storage":5368709120,"media":36000}','{"hosted_execution":true,"dlp":false,"sso":false,"scim":false}'),
 ('team',1,'Team',1000,'{"models":10000000,"tools":100000,"runtime":360000,"storage":536870912000,"media":3600000}','{"hosted_execution":true,"dlp":true,"sso":false,"scim":false}'),
 ('enterprise',1,'Enterprise',100000,'{"models":1000000000,"tools":10000000,"runtime":36000000,"storage":53687091200000,"media":360000000}','{"hosted_execution":true,"dlp":true,"sso":true,"scim":true}');
CREATE TABLE billing_accounts (
 organization_id uuid PRIMARY KEY REFERENCES organizations,mode text NOT NULL DEFAULT 'self_hosted' CHECK(mode IN ('self_hosted','managed')),
 plan_id text NOT NULL DEFAULT 'free',plan_revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'free' CHECK(status IN ('free','trialing','active','past_due','cancelled')),
 trial_used boolean NOT NULL DEFAULT false,trial_ends_at timestamptz,trial_key uuid,
 period_start timestamptz NOT NULL DEFAULT date_trunc('month',now()),period_end timestamptz NOT NULL DEFAULT date_trunc('month',now())+interval '1 month',
 budget_micros bigint CHECK(budget_micros>=0),warning_percent integer NOT NULL DEFAULT 80 CHECK(warning_percent BETWEEN 1 AND 99),version integer NOT NULL DEFAULT 1,
 seat_epoch bigint NOT NULL DEFAULT 1,
 provider_customer_id text UNIQUE,provider_subscription_id text UNIQUE,cancel_at_period_end boolean NOT NULL DEFAULT false,
 FOREIGN KEY(plan_id,plan_revision) REFERENCES billing_plans(id,revision),CHECK(period_end>period_start)
);
INSERT INTO billing_accounts(organization_id) SELECT id FROM organizations;
CREATE FUNCTION initialize_billing_account() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 INSERT INTO public.billing_accounts(organization_id,mode) SELECT NEW.id,mode FROM public.commercial_configuration WHERE id=true;RETURN NEW;END $body$;
CREATE TRIGGER organization_billing AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION initialize_billing_account();
CREATE TABLE billing_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,organization_id uuid NOT NULL,category text NOT NULL CHECK(category IN ('models','tools','runtime','media')),
 reference uuid NOT NULL,units bigint NOT NULL CHECK(units>=0),cost_micros bigint NOT NULL CHECK(cost_micros>=0),state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','cancelled')),
 actual_units bigint,actual_cost_micros bigint,confidence text,created_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
 UNIQUE(workspace_id,category,reference),FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id)
);
CREATE TABLE usage_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,organization_id uuid NOT NULL,category text NOT NULL CHECK(category IN ('models','tools','runtime','storage','media')),
 reference uuid NOT NULL,units_delta bigint NOT NULL,cost_micros bigint NOT NULL,confidence text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,category,reference),FOREIGN KEY(organization_id,workspace_id) REFERENCES workspaces(organization_id,id)
);
CREATE INDEX usage_account_period ON usage_ledger(organization_id,created_at,category);
CREATE INDEX usage_pending ON billing_reservations(organization_id,created_at) WHERE state='reserved';
CREATE TABLE billing_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations,request_key uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('checkout','portal','cancel','plan_change','reconcile')),request_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','sending','succeeded','failed','outcome_unknown')),provider_id text,error_code text,result_url text,payload jsonb,lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,request_key)
);
CREATE TABLE billing_events (
 id text PRIMARY KEY,provider text NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),organization_id uuid REFERENCES organizations,
 state text NOT NULL CHECK(state IN ('pending','processed','failed','ignored')),payload_hash text NOT NULL,error_code text,subscription_id text,invoice_id text,attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz
);
CREATE TABLE billing_invoices (
 id text PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations,currency text NOT NULL,total_minor bigint NOT NULL,status text NOT NULL,
 period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,hosted_url text,issued_at timestamptz NOT NULL
);
DO $body$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['commercial_configuration','billing_plans','billing_accounts','billing_reservations','usage_ledger','billing_commands','billing_events','billing_invoices'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO ao_identity',t);
 EXECUTE format('CREATE POLICY identity_boundary ON %I TO ao_identity USING(true) WITH CHECK(true)',t);
 END LOOP;
END $body$;
REVOKE UPDATE,DELETE ON usage_ledger FROM ao_identity;
CREATE FUNCTION commercial_plan(tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT CASE WHEN a.mode='self_hosted' THEN '{"mode":"self_hosted","features":{"hosted_execution":true,"dlp":true,"sso":true,"scim":true}}'::jsonb ELSE jsonb_build_object('mode',a.mode,'features',p.features,'allowances',p.allowances,'humanSeats',p.human_seats) END
 FROM public.workspaces w JOIN public.billing_accounts a ON a.organization_id=w.organization_id JOIN public.billing_plans p ON p.id=CASE WHEN a.status='trialing' AND a.trial_ends_at>now() THEN 'team' WHEN a.status='active' THEN a.plan_id ELSE 'free' END AND p.revision=1
 WHERE w.id=tenant AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
$body$;
CREATE FUNCTION commercial_seats(org uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
 SELECT count(DISTINCT m.account_id)::int FROM public.memberships m JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.accounts a ON a.id=m.account_id WHERE w.organization_id=org AND m.kind='human' AND m.status='active' AND m.access_type='member' AND a.disabled_at IS NULL
$body$;
CREATE FUNCTION enforce_commercial_seats() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE account public.billing_accounts;limit_seats integer;used integer;
BEGIN
 IF NEW.kind<>'human' OR NEW.status<>'active' OR NEW.access_type<>'member' THEN RETURN NEW;END IF;
 SELECT a.* INTO account FROM public.billing_accounts a JOIN public.workspaces w ON w.organization_id=a.organization_id WHERE w.id=NEW.workspace_id FOR UPDATE OF a;
 IF account.mode='self_hosted' THEN RETURN NEW;END IF;
 SELECT human_seats INTO limit_seats FROM public.billing_plans WHERE id=CASE WHEN account.status='trialing' AND account.trial_ends_at>now() THEN 'team' WHEN account.status='active' THEN account.plan_id ELSE 'free' END AND revision=1;
 SELECT count(*)::int INTO used FROM(SELECT DISTINCT m.account_id FROM public.memberships m JOIN public.workspaces w ON w.id=m.workspace_id JOIN public.accounts a ON a.id=m.account_id WHERE w.organization_id=account.organization_id AND m.status='active' AND m.kind='human' AND m.access_type='member' AND a.disabled_at IS NULL AND m.id<>NEW.id UNION SELECT NEW.account_id) seats;
 IF used>limit_seats THEN RAISE EXCEPTION 'Human seat allowance exceeded' USING ERRCODE='AOB01';END IF;RETURN NEW;
END $body$;
CREATE TRIGGER membership_seat_admission BEFORE INSERT OR UPDATE OF status,access_type,account_id ON memberships FOR EACH ROW EXECUTE FUNCTION enforce_commercial_seats();
CREATE FUNCTION commercial_reserve(tenant uuid,meter text,source uuid,quantity bigint,amount bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE account public.billing_accounts;allowance bigint;used bigint;spent bigint;existing public.billing_reservations;BEGIN
 IF (tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid AND current_setting('role',true) IN ('ao_runtime','ao_worker')) OR quantity<0 OR amount<0 OR meter NOT IN ('models','tools','runtime','media') THEN RAISE EXCEPTION 'Invalid commercial admission' USING ERRCODE='42501';END IF;
 SELECT a.* INTO account FROM public.billing_accounts a JOIN public.workspaces w ON w.organization_id=a.organization_id WHERE w.id=tenant FOR UPDATE OF a;
 SELECT * INTO existing FROM public.billing_reservations WHERE workspace_id=tenant AND category=meter AND reference=source;
 IF existing.id IS NOT NULL THEN IF existing.units<>quantity OR existing.cost_micros<>amount THEN RAISE EXCEPTION 'Reservation request changed' USING ERRCODE='AOB03';END IF;RETURN;END IF;
 IF account.mode='managed' THEN
 SELECT (allowances->>meter)::bigint INTO allowance FROM public.billing_plans WHERE id=CASE WHEN account.status='trialing' AND account.trial_ends_at>now() THEN 'team' WHEN account.status='active' THEN account.plan_id ELSE 'free' END AND revision=1;
 SELECT coalesce(sum(units_delta),0) INTO used FROM public.usage_ledger WHERE organization_id=account.organization_id AND category=meter AND created_at>=account.period_start AND created_at<account.period_end;
 SELECT used+coalesce(sum(units),0) INTO used FROM public.billing_reservations WHERE organization_id=account.organization_id AND category=meter AND state='reserved';
 IF used+quantity>allowance THEN RAISE EXCEPTION 'Usage allowance or budget exceeded' USING ERRCODE='AOB02';END IF;
 END IF;
 IF account.budget_micros IS NOT NULL THEN
 SELECT coalesce(sum(cost_micros),0) INTO spent FROM public.usage_ledger WHERE organization_id=account.organization_id AND created_at>=account.period_start AND created_at<account.period_end;
 SELECT spent+coalesce(sum(cost_micros),0) INTO spent FROM public.billing_reservations WHERE organization_id=account.organization_id AND state='reserved';
 IF spent+amount>account.budget_micros THEN RAISE EXCEPTION 'Hard budget exceeded' USING ERRCODE='AOB02';END IF;END IF;
 INSERT INTO public.billing_reservations(workspace_id,organization_id,category,reference,units,cost_micros) VALUES(tenant,account.organization_id,meter,source,quantity,amount);
END $body$;
CREATE FUNCTION commercial_settle(tenant uuid,meter text,source uuid,quantity bigint,amount bigint,proof text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE reservation public.billing_reservations;BEGIN
 IF (tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid AND current_setting('role',true) IN ('ao_runtime','ao_worker')) OR quantity<0 OR amount<0 THEN RAISE EXCEPTION 'Invalid usage receipt' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.billing_accounts a JOIN public.workspaces w ON w.organization_id=a.organization_id WHERE w.id=tenant FOR UPDATE OF a;
 SELECT * INTO reservation FROM public.billing_reservations WHERE workspace_id=tenant AND category=meter AND reference=source FOR UPDATE;
 IF reservation.id IS NULL OR reservation.state<>'reserved' THEN RETURN;END IF;
 INSERT INTO public.usage_ledger(workspace_id,organization_id,category,reference,units_delta,cost_micros,confidence) VALUES(tenant,reservation.organization_id,meter,source,quantity,amount,proof);
 UPDATE public.billing_reservations SET state='settled',actual_units=quantity,actual_cost_micros=amount,confidence=proof,settled_at=now() WHERE id=reservation.id;
END $body$;
CREATE FUNCTION commercial_storage_meter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
DECLARE account public.billing_accounts;quota bigint;used bigint;BEGIN
 IF NEW.storage_bytes=OLD.storage_bytes THEN RETURN NEW;END IF;
 SELECT * INTO account FROM public.billing_accounts WHERE organization_id=NEW.organization_id FOR UPDATE;
 IF account.mode='managed' AND NEW.storage_bytes>OLD.storage_bytes THEN
 SELECT (allowances->>'storage')::bigint INTO quota FROM public.billing_plans WHERE id=CASE WHEN account.status='trialing' AND account.trial_ends_at>now() THEN 'team' WHEN account.status='active' THEN account.plan_id ELSE 'free' END AND revision=1;
 SELECT coalesce(sum(storage_bytes),0)+NEW.storage_bytes INTO used FROM public.workspaces WHERE organization_id=NEW.organization_id AND id<>NEW.id;
 IF used>quota THEN RAISE EXCEPTION 'Organization storage allowance exceeded' USING ERRCODE='AOB02';END IF;END IF;
 INSERT INTO public.usage_ledger(workspace_id,organization_id,category,reference,units_delta,cost_micros,confidence) VALUES(NEW.id,NEW.organization_id,'storage',gen_random_uuid(),NEW.storage_bytes-OLD.storage_bytes,0,'storage_allocation_not_priced');RETURN NEW;
END $body$;
CREATE TRIGGER commercial_storage BEFORE UPDATE OF storage_bytes ON workspaces FOR EACH ROW EXECUTE FUNCTION commercial_storage_meter();
CREATE FUNCTION commercial_tool_meter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
 IF NEW.status='executing' AND OLD.status<>'executing' THEN PERFORM public.commercial_reserve(NEW.workspace_id,'tools',NEW.id,1,0);END IF;
 IF NEW.status IN ('succeeded','failed','denied','expired') AND OLD.status IN ('executing','outcome_unknown') THEN PERFORM public.commercial_settle(NEW.workspace_id,'tools',NEW.id,1,0,'invocation_not_priced');END IF;RETURN NEW;
END $body$;
CREATE TRIGGER commercial_tools BEFORE UPDATE OF status ON tool_invocations FOR EACH ROW EXECUTE FUNCTION commercial_tool_meter();
REVOKE ALL ON FUNCTION commercial_plan(uuid),commercial_seats(uuid),commercial_reserve(uuid,text,uuid,bigint,bigint),commercial_settle(uuid,text,uuid,bigint,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commercial_plan(uuid),commercial_reserve(uuid,text,uuid,bigint,bigint),commercial_settle(uuid,text,uuid,bigint,bigint,text) TO ao_runtime,ao_worker;
GRANT EXECUTE ON FUNCTION commercial_seats(uuid) TO ao_identity;
CREATE FUNCTION commercial_seat_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 UPDATE public.billing_accounts SET seat_epoch=seat_epoch+1 WHERE organization_id=(SELECT organization_id FROM public.workspaces WHERE id=coalesce(NEW.workspace_id,OLD.workspace_id));RETURN NULL;END $body$;
CREATE TRIGGER membership_seat_epoch AFTER INSERT OR UPDATE OF status,access_type,account_id OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION commercial_seat_epoch();
CREATE TABLE billing_quotes (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations,plan text NOT NULL,price_id text NOT NULL,subscription_id text NOT NULL,seats integer NOT NULL,seat_epoch bigint NOT NULL,
 amount_minor bigint NOT NULL,currency text NOT NULL,proration_date bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
ALTER TABLE billing_quotes ENABLE ROW LEVEL SECURITY;ALTER TABLE billing_quotes FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON billing_quotes TO ao_identity;
CREATE POLICY billing_quote_identity ON billing_quotes TO ao_identity USING(true) WITH CHECK(true);
ALTER TABLE call_participants ADD COLUMN meter_reference uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE call_participants ADD COLUMN meter_started_at timestamptz NOT NULL DEFAULT now();
CREATE FUNCTION commercial_media_meter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 IF OLD.state='joined' AND NEW.state<>'joined' THEN PERFORM public.commercial_settle(NEW.workspace_id,'media',OLD.meter_reference,least(14400,greatest(0,ceil(extract(epoch FROM least(now(),OLD.expires_at)-OLD.meter_started_at))))::bigint,0,'participant_lease_seconds_not_priced');END IF;RETURN NEW;
END $body$;
CREATE TRIGGER commercial_media BEFORE UPDATE OF state ON call_participants FOR EACH ROW EXECUTE FUNCTION commercial_media_meter();
ALTER TABLE billing_reservations ADD COLUMN reconciliation_version integer NOT NULL DEFAULT 1;
CREATE TABLE billing_receipts(id text PRIMARY KEY,workspace_id uuid NOT NULL,category text NOT NULL,reference uuid NOT NULL,body_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE billing_receipts ENABLE ROW LEVEL SECURITY;ALTER TABLE billing_receipts FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON billing_receipts TO ao_identity;
CREATE POLICY operator_receipt ON billing_receipts TO ao_identity USING(true) WITH CHECK(true);

ALTER TABLE billing_accounts ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE billing_accounts ADD COLUMN reconcile_lease uuid;
ALTER TABLE billing_accounts ADD COLUMN reconcile_lease_until timestamptz;
ALTER TABLE billing_receipts ADD COLUMN adjustment_id uuid NOT NULL UNIQUE;
