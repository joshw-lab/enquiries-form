-- Add event types for re-ingestion prevention and disposition fallback archival.
ALTER TABLE lead_routing_events DROP CONSTRAINT IF EXISTS lead_routing_events_event_type_check;
ALTER TABLE lead_routing_events ADD CONSTRAINT lead_routing_events_event_type_check
  CHECK (event_type IN (
    'ingested',
    'skipped_duplicate',
    'skipped_previously_disposed',
    'moved_hot_to_new',
    'moved_new_to_old',
    'moved_manual',
    'reconcile_moved',
    'reconcile_archived',
    'reconcile_orphaned',
    'disposition_archived',
    'disposition_archived_fallback',
    'remediation_archived'
  ));
