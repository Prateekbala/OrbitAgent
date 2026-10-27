CREATE FUNCTION memory_graph_valid(tenant uuid,refs jsonb,target uuid DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean;ref jsonb;BEGIN
 IF tenant IS NULL OR tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR refs IS NULL OR jsonb_typeof(refs)<>'array' THEN RETURN false;END IF;
 IF jsonb_array_length(refs) NOT BETWEEN 1 AND 20 THEN RETURN false;END IF;
 WITH RECURSIVE paths(kind,id,depth,ancestors,cycle) AS (
  SELECT r->>'kind',(r->>'id')::uuid,1,ARRAY[]::uuid[],false FROM jsonb_array_elements(refs) r
  UNION ALL
  SELECT r->>'kind',(r->>'id')::uuid,p.depth+1,p.ancestors||p.id,(r->>'kind'='memory' AND (r->>'id')::uuid=ANY(p.ancestors||p.id))
  FROM paths p JOIN public.agent_memories m ON p.kind='memory' AND m.workspace_id=tenant AND m.id=p.id
  CROSS JOIN LATERAL jsonb_array_elements(m.sources) r WHERE p.depth<=8 AND NOT p.cycle
 ), bounded AS(SELECT * FROM paths LIMIT 129)
 SELECT count(*)<=128 AND coalesce(max(depth),0)<=8 AND NOT coalesce(bool_or(cycle OR (kind='memory' AND id=target)),false) INTO allowed FROM bounded;
 IF NOT coalesce(allowed,false) THEN RETURN false;END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF NOT public.retrieval_source_visible(tenant,ref->>'kind',(ref->>'id')::uuid,nullif(current_setting('ao.membership_id',true),'')::uuid) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;END $$;
REVOKE ALL ON FUNCTION memory_graph_valid(uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_graph_valid(uuid,jsonb,uuid) TO ao_runtime,ao_worker;
