-- RPC function: pipeline_tier_metrics
-- Returns tier-level metrics per region for the pipeline dashboard.
-- Combines: tier counts, new-today counts, today's calls, total passes, and avg response time.

CREATE OR REPLACE FUNCTION pipeline_tier_metrics(today_start timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH tier_counts AS (
    -- Query A: Total active + new today per tier per region
    SELECT
      r.contact_state,
      r.current_tier,
      COUNT(*) AS total_active,
      COUNT(*) FILTER (WHERE
        (r.current_tier = 'HOT' AND r.ingested_at >= today_start) OR
        (r.current_tier = 'NEW' AND r.moved_to_new_at >= today_start) OR
        (r.current_tier = 'OLD' AND r.moved_to_old_at >= today_start)
      ) AS new_today
    FROM ringcx_lead_routing r
    WHERE r.ringcx_lead_id IS NOT NULL
      AND r.contact_state IS NOT NULL
    GROUP BY r.contact_state, r.current_tier
  ),
  call_counts AS (
    -- Query B: Calls today + total passes per tier per region
    SELECT
      r.contact_state,
      r.current_tier,
      COUNT(*) FILTER (WHERE c.call_start >= today_start) AS calls_today,
      COUNT(*) AS total_passes
    FROM call_recordings c
    JOIN ringcx_lead_routing r ON c.hubspot_contact_id = r.contact_id
    WHERE c.call_start >= r.ingested_at
      AND r.ringcx_lead_id IS NOT NULL
      AND r.contact_state IS NOT NULL
    GROUP BY r.contact_state, r.current_tier
  ),
  avg_resp AS (
    -- Query C: Avg response time for HOT leads (lead_date to first call)
    SELECT
      r.contact_state,
      AVG(EXTRACT(EPOCH FROM (first_call.min_call_start - r.lead_date))) AS avg_response_seconds
    FROM ringcx_lead_routing r
    JOIN LATERAL (
      SELECT MIN(c.call_start) AS min_call_start
      FROM call_recordings c
      WHERE c.hubspot_contact_id = r.contact_id
        AND c.call_start >= r.lead_date
    ) first_call ON first_call.min_call_start IS NOT NULL
    WHERE r.current_tier = 'HOT'
      AND r.ringcx_lead_id IS NOT NULL
      AND r.contact_state IS NOT NULL
    GROUP BY r.contact_state
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
