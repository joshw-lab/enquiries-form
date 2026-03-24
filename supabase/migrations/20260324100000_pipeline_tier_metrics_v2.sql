-- RPC function: pipeline_tier_metrics (v2)
-- Rewritten to use lead_loads + call_recordings instead of ringcx_lead_routing
-- (which is not yet populated). Tiers are derived from lead_date age:
--   HOT = lead_date within last 3 days
--   NEW = lead_date 3-90 days ago
--   OLD = lead_date 90+ days ago

CREATE OR REPLACE FUNCTION pipeline_tier_metrics(today_start timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result jsonb;
  now_ts timestamptz := now();
BEGIN
  WITH
  -- Deduplicate lead_loads to one row per contact (most recent load)
  distinct_leads AS (
    SELECT DISTINCT ON (contact_id)
      contact_id,
      contact_state,
      (priority_context->>'lead_date')::date AS lead_date,
      created_at
    FROM lead_loads
    WHERE contact_state IS NOT NULL
      AND priority_context->>'lead_date' IS NOT NULL
    ORDER BY contact_id, created_at DESC
  ),
  -- Assign tier based on lead_date age
  leads_with_tier AS (
    SELECT
      dl.*,
      CASE
        WHEN (now_ts - dl.lead_date) < interval '3 days' THEN 'HOT'
        WHEN (now_ts - dl.lead_date) < interval '90 days' THEN 'NEW'
        ELSE 'OLD'
      END AS current_tier
    FROM distinct_leads dl
  ),
  -- Query A: Tier counts + new today per region
  tier_counts AS (
    SELECT
      contact_state,
      current_tier,
      COUNT(*) AS total_active,
      COUNT(*) FILTER (WHERE created_at >= today_start) AS new_today
    FROM leads_with_tier
    GROUP BY contact_state, current_tier
  ),
  -- Query B: Calls today + total passes per tier per region
  call_counts AS (
    SELECT
      lt.contact_state,
      lt.current_tier,
      COUNT(*) FILTER (WHERE c.call_start >= today_start) AS calls_today,
      COUNT(*) AS total_passes
    FROM call_recordings c
    JOIN leads_with_tier lt ON c.hubspot_contact_id = lt.contact_id
    WHERE c.call_start >= lt.created_at  -- only count calls since lead was loaded
    GROUP BY lt.contact_state, lt.current_tier
  ),
  -- Query C: Avg response time for HOT leads (lead_date to first call)
  avg_resp AS (
    SELECT
      lt.contact_state,
      AVG(EXTRACT(EPOCH FROM (first_call.min_call_start - lt.lead_date))) AS avg_response_seconds
    FROM leads_with_tier lt
    JOIN LATERAL (
      SELECT MIN(c.call_start) AS min_call_start
      FROM call_recordings c
      WHERE c.hubspot_contact_id = lt.contact_id
        AND c.call_start >= lt.lead_date
    ) first_call ON first_call.min_call_start IS NOT NULL
    WHERE lt.current_tier = 'HOT'
    GROUP BY lt.contact_state
  )
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
      FROM tier_counts t
      LEFT JOIN call_counts cc
        ON cc.contact_state = t.contact_state
        AND cc.current_tier = t.current_tier
    ), '[]'::jsonb),
    'avg_response',
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'contact_state', a.contact_state,
        'avg_response_seconds', a.avg_response_seconds
      ))
      FROM avg_resp a
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;
