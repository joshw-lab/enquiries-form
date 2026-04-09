-- Add aging audit trail event types:
--   aging_run_summary: logged per cron run for daily compliance reporting
--   aging_orphan_removed: lead exists in routing but not in RingCX
-- Also allow 'ARCHIVED' in to_tier for orphan removal events.

ALTER TABLE lead_routing_events DROP CONSTRAINT IF EXISTS lead_routing_events_event_type_check;
ALTER TABLE lead_routing_events ADD CONSTRAINT lead_routing_events_event_type_check
  CHECK (event_type IN (
    'ingested',
    'skipped_duplicate',
    'skipped_previously_disposed',
    'skipped_outside_service_area',
    'moved_hot_to_new',
    'moved_new_to_old',
    'moved_manual',
    'reconcile_loaded',
    'reconcile_moved',
    'reconcile_archived',
    'reconcile_orphaned',
    'disposition_archived',
    'disposition_archived_fallback',
    'remediation_archived',
    'aging_orphan_removed',
    'aging_run_summary'
  ));

ALTER TABLE lead_routing_events DROP CONSTRAINT IF EXISTS lead_routing_events_to_tier_check;
ALTER TABLE lead_routing_events ADD CONSTRAINT lead_routing_events_to_tier_check
  CHECK (to_tier IS NULL OR to_tier IN ('HOT', 'NEW', 'OLD', 'ARCHIVED'));
