-- Dashboard configuration table for configurable thresholds
create table if not exists dashboard_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- Seed default threshold values
insert into dashboard_config (key, value) values
  ('thresholds', '{
    "calendarFillUrgent": 25,
    "calendarFillWarn": 50,
    "hotLeadsUrgent": 20,
    "hotLeadsWarn": 10,
    "avgResponseUrgent": 6,
    "avgResponseWarn": 3,
    "ringcxDeltaUrgent": 20,
    "ringcxDeltaWarn": 1,
    "refreshInterval": 60,
    "agedMaxDays": 180
  }'::jsonb)
on conflict (key) do nothing;
