-- 2-way SMS POC: conversation log keyed by the other party's E.164 phone.
-- contact_id is the HubSpot hs_object_id when known (null for unmatched inbound).

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  contact_id text,
  phone_e164 text not null,
  direction text not null check (direction in ('inbound','outbound')),
  from_number text not null,
  to_number text not null,
  body text not null,
  twilio_sid text unique,
  status text,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists sms_messages_phone_created_idx
  on public.sms_messages (phone_e164, created_at desc);

create index if not exists sms_messages_contact_created_idx
  on public.sms_messages (contact_id, created_at desc);
