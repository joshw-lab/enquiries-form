-- v4: Fix statement timeout by using temp table + index for the dedup step
-- instead of inline CTE that gets re-evaluated by the planner.
CREATE OR REPLACE FUNCTION pipeline_tier_metrics(today_start timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '15s'
AS $$
DECLARE
  result jsonb;
  now_ts timestamptz := now();
BEGIN
  -- Materialize deduped leads into a temp table for reuse across queries
  CREATE TEMP TABLE _pl_leads ON COMMIT DROP AS
    SELECT DISTINCT ON (contact_id)
      contact_id,
      contact_state,
      (priority_context->>'lead_date')::date AS lead_date,
      created_at,
      CASE
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '3 days' THEN 'HOT'
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '90 days' THEN 'NEW'
        ELSE 'OLD'
      END AS current_tier,
      CASE
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '1 day' THEN 0
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '3 days' THEN 1
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '7 days' THEN 2
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '30 days' THEN 3
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '45 days' THEN 4
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '60 days' THEN 5
        WHEN (now_ts - (priority_context->>'lead_date')::date) < interval '90 days' THEN 6
        ELSE 7
      END AS bucket_index
    FROM lead_loads
    WHERE contact_state IS NOT NULL
      AND priority_context->>'lead_date' IS NOT NULL
    ORDER BY contact_id, created_at DESC;

  -- Index the temp table for the call_recordings join
  CREATE INDEX ON _pl_leads (contact_id);

  SELECT jsonb_build_object(
    'tiers',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_state', t.contact_state,
        'current_tier', t.current_tier,
        'total_active', t.total_active,
        'new_today', t.new_today,
        'calls_today', COALESCE(cc.calls_today, 0),
        'total_passes', COALESCE(cc.total_passes, 0)
      ))
      FROM (
        SELECT contact_state, current_tier,
               COUNT(*) AS total_active,
               COUNT(*) FILTER (WHERE created_at >= today_start) AS new_today
        FROM _pl_leads
        GROUP BY contact_state, current_tier
      ) t
      LEFT JOIN (
        SELECT lt.contact_state, lt.current_tier,
               COUNT(*) FILTER (WHERE c.call_start >= today_start) AS calls_today,
               COUNT(*) AS total_passes
        FROM call_recordings c
        JOIN _pl_leads lt ON c.hubspot_contact_id = lt.contact_id
        WHERE c.call_start >= lt.created_at
        GROUP BY lt.contact_state, lt.current_tier
      ) cc ON cc.contact_state = t.contact_state AND cc.current_tier = t.current_tier
    ), '[]'::jsonb),

    'avg_response',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_state', a.contact_state,
        'avg_response_seconds', a.avg_response_seconds
      ))
      FROM (
        SELECT lt.contact_state,
               AVG(EXTRACT(EPOCH FROM (fc.first_call - lt.lead_date))) AS avg_response_seconds
        FROM _pl_leads lt
        JOIN (
          SELECT hubspot_contact_id, MIN(call_start) AS first_call
          FROM call_recordings
          GROUP BY hubspot_contact_id
        ) fc ON fc.hubspot_contact_id = lt.contact_id AND fc.first_call >= lt.lead_date
        WHERE lt.created_at >= today_start
        GROUP BY lt.contact_state
      ) a
    ), '[]'::jsonb),

    'buckets',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_state', b.contact_state,
        'bucket_index', b.bucket_index,
        'count', b.cnt
      ))
      FROM (
        SELECT contact_state, bucket_index, COUNT(*) AS cnt
        FROM _pl_leads
        GROUP BY contact_state, bucket_index
      ) b
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;
