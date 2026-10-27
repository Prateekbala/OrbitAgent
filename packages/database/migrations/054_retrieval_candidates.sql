CREATE FUNCTION retrieval_candidates(tenant uuid,query_text text,allowed_kinds text[],member uuid,semantic boolean,maximum integer)
RETURNS TABLE(kind text,source_id uuid,ordinal integer,lexical_rank real)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog ROWS 301 AS $$
BEGIN
 IF tenant IS DISTINCT FROM nullif(current_setting('ao.workspace_id',true),'')::uuid OR member IS DISTINCT FROM nullif(current_setting('ao.membership_id',true),'')::uuid OR maximum NOT BETWEEN 1 AND 301 OR length(query_text)>5000 THEN RETURN;END IF;
 IF semantic THEN
  RETURN QUERY SELECT c.kind,c.source_id,c.ordinal,ts_rank_cd(c.terms,websearch_to_tsquery('simple',query_text))
  FROM public.retrieval_chunks c JOIN public.retrieval_documents d USING(workspace_id,kind,source_id)
  WHERE c.workspace_id=tenant AND (allowed_kinds IS NULL OR c.kind=ANY(allowed_kinds))
   AND public.retrieval_source_visible(tenant,c.kind,c.source_id,member) AND d.source_version=public.retrieval_source_version(tenant,c.kind,c.source_id)
  ORDER BY 4 DESC,d.indexed_at DESC,c.source_id,c.ordinal LIMIT maximum;
 ELSE
  RETURN QUERY SELECT c.kind,c.source_id,c.ordinal,ts_rank_cd(c.terms,websearch_to_tsquery('simple',query_text))
  FROM public.retrieval_chunks c JOIN public.retrieval_documents d USING(workspace_id,kind,source_id)
  WHERE c.workspace_id=tenant AND (allowed_kinds IS NULL OR c.kind=ANY(allowed_kinds))
   AND c.terms @@ websearch_to_tsquery('simple',query_text)
   AND public.retrieval_source_visible(tenant,c.kind,c.source_id,member) AND d.source_version=public.retrieval_source_version(tenant,c.kind,c.source_id)
  ORDER BY 4 DESC,d.indexed_at DESC,c.source_id,c.ordinal LIMIT maximum;
 END IF;
END $$;
REVOKE ALL ON FUNCTION retrieval_candidates(uuid,text,text[],uuid,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retrieval_candidates(uuid,text,text[],uuid,boolean,integer) TO ao_runtime;
