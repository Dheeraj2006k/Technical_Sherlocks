-- SQL06 evidence schema (create table statements only), imported from the supplied seed and schema files

create table access_audit (
  audit_id text not null,
  event_at timestamp not null,
  actor text not null,
  action text not null,
  object_ref text not null,
  result text not null,
  workstation text not null,
  primary key (audit_id)
);

create table account_snapshots (
  snapshot_id text not null,
  account_name text not null,
  recorded_at timestamp not null,
  available_balance numeric(10,2) not null,
  pending_balance numeric(10,2) not null,
  source_system text not null,
  note text not null,
  primary key (snapshot_id)
);

create table approval_registry (
  approval_code text not null,
  approver text not null,
  approved_at timestamp not null,
  amount_limit numeric(10,2) not null,
  approved_payee text not null,
  approved_purpose text not null,
  status text not null,
  primary key (approval_code)
);

create table gateway_events (
  event_id text not null,
  event_at timestamp not null,
  reference_code text not null,
  event_type text not null,
  gateway_status text not null,
  amount numeric(10,2) not null,
  destination_fingerprint text not null,
  terminal_id text not null,
  operator_note text not null,
  primary key (event_id)
);

create table ledger_entries (
  entry_id text not null,
  posted_at timestamp not null,
  account_code text not null,
  entry_type text not null,
  amount numeric(10,2) not null,
  reference_code text not null,
  entered_by text not null,
  description text not null,
  status text not null,
  primary key (entry_id),
  check ((amount > (0)::numeric)),
  check ((entry_type = ANY (ARRAY['CREDIT'::text, 'DEBIT'::text, 'REVERSAL'::text]))),
  check ((status = ANY (ARRAY['POSTED'::text, 'PENDING'::text, 'REVERSED'::text])))
);

create table payment_requests (
  request_id text not null,
  requested_at timestamp not null,
  requested_by text not null,
  payee text not null,
  amount numeric(10,2) not null,
  purpose text not null,
  approval_code text,
  request_status text not null,
  submitted_channel text not null,
  primary key (request_id)
);

create table reconciliation_notes (
  note_id text not null,
  created_at timestamp not null,
  author text not null,
  topic text not null,
  note_text text not null,
  visibility text not null,
  primary key (note_id)
);

create table staff_directory (
  staff_id text not null,
  full_name text not null,
  role_title text not null,
  normal_duties text not null,
  known_context text not null,
  primary key (staff_id)
);
