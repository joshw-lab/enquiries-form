-- Returns today's new leads with their first call time for speed-to-lead display.
-- Used by the DrillPanel modal third column.
-- Accepts today_date as a plain date to avoid UTC timezone cast issues.
CREATE OR REPLACE FUNCTION today_new_leads(today_start timestamptz, today_date date DEFAULT NULL)
RETURNS TABLE (
  contact_id text,
  contact_name text,
  contact_state text,
  contact_postcode text,
  lead_date timestamptz,
  loaded_at timestamptz,
  first_call_at timestamptz,
  speed_to_lead_seconds double precision
)
LANGUAGE plpgsql
STABLE
SET statement_timeout = '10s'
AS $$
DECLARE
  filter_date date := COALESCE(today_date, today_start::date);
BEGIN
  RETURN QUERY
  SELECT
    ll.contact_id,
    COALESCE(NULLIF(TRIM(ll.contact_first_name || ' ' || ll.contact_last_name), ''), 'Unknown') AS contact_name,
    ll.contact_state,
    COALESCE(ll.contact_postcode, '') AS contact_postcode,
    (ll.priority_context->>'lead_date')::timestamptz AS lead_date,
    ll.created_at AS loaded_at,
    fc.first_call_at,
    CASE
      WHEN fc.first_call_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (fc.first_call_at - (ll.priority_context->>'lead_date')::timestamptz))::double precision
      ELSE NULL
    END AS speed_to_lead_seconds
  FROM (
    SELECT DISTINCT ON (l.contact_id)
      l.contact_id,
      l.contact_first_name,
      l.contact_last_name,
      l.contact_state,
      l.contact_postcode,
      l.priority_context,
      l.created_at
    FROM lead_loads l
    WHERE l.priority_context->>'lead_date' IS NOT NULL
      AND (l.priority_context->>'lead_date')::date >= filter_date
      AND l.contact_state IS NOT NULL
    ORDER BY l.contact_id, l.created_at DESC
  ) ll
  LEFT JOIN LATERAL (
    SELECT MIN(cr.call_start) AS first_call_at
    FROM call_recordings cr
    WHERE cr.hubspot_contact_id = ll.contact_id
      AND cr.call_start >= (ll.priority_context->>'lead_date')::timestamptz
  ) fc ON true
  ORDER BY ll.created_at DESC;
END;
$$;
