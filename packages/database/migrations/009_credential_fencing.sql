ALTER TABLE agent_runs ADD COLUMN requester_auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE approval_decisions ADD COLUMN approver_auth_version integer NOT NULL DEFAULT 1;
CREATE FUNCTION public.member_account_authority(tenant uuid,member uuid)
RETURNS TABLE(auth_version integer,verified boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
AS $authority$
 SELECT a.auth_version,a.email_verified_at IS NOT NULL
 FROM public.accounts a JOIN public.memberships m ON m.account_id=a.id
 WHERE m.workspace_id=tenant AND m.id=member AND m.status='active'
 AND tenant=nullif(current_setting('ao.workspace_id',true),'')::uuid
 FOR SHARE OF a
$authority$;
REVOKE ALL ON FUNCTION public.member_account_authority(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.member_account_authority(uuid,uuid) TO ao_runtime,ao_worker,ao_identity;
