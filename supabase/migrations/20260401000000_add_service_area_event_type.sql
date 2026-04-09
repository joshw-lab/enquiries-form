-- Add 'skipped_outside_service_area' event type for leads blocked by postcode filter.
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
    'remediation_archived'
  ));
