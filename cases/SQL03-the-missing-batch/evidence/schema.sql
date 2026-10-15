-- SQL03 evidence schema (create table statements only), imported from the supplied seed and schema files

create table sql03_characters (
  character_id text not null,
  display_name text not null,
  role text not null,
  public_description text not null,
  primary key (character_id)
);

create table sql03_approval_audit (
  audit_id text not null,
  request_id text not null,
  action_at timestamp not null,
  actor_id text not null,
  action text not null,
  approval_ref text,
  result text not null,
  note text not null,
  primary key (audit_id),
  foreign key (actor_id) references sql03_characters(character_id)
);

create table sql03_custody_scans (
  scan_id text not null,
  batch_id text not null,
  event_at timestamp not null,
  location text not null,
  scanned_by text not null,
  scan_type text not null,
  package_state text not null,
  note text not null,
  primary key (scan_id),
  foreign key (scanned_by) references sql03_characters(character_id)
);

create table sql03_desk_receipts (
  receipt_id text not null,
  batch_id text not null,
  received_at timestamp not null,
  received_by text not null,
  item_received text not null,
  quantity_received integer not null,
  condition_note text not null,
  primary key (receipt_id),
  foreign key (received_by) references sql03_characters(character_id),
  check ((quantity_received >= 0))
);

create table sql03_messages (
  message_id text not null,
  sent_at timestamp not null,
  sender_id text not null,
  recipient_id text not null,
  channel text not null,
  message_text text not null,
  primary key (message_id),
  foreign key (recipient_id) references sql03_characters(character_id),
  foreign key (sender_id) references sql03_characters(character_id)
);

create table sql03_print_jobs (
  job_id text not null,
  batch_id text not null,
  requested_by text not null,
  printed_by text not null,
  created_at timestamp not null,
  quantity integer not null,
  destination text not null,
  approval_ref text,
  job_status text not null,
  note text not null,
  primary key (job_id),
  foreign key (printed_by) references sql03_characters(character_id),
  foreign key (requested_by) references sql03_characters(character_id),
  check ((quantity > 0))
);

create table sql03_route_manifests (
  manifest_id text not null,
  batch_id text not null,
  created_at timestamp not null,
  route_name text not null,
  planned_runner text not null,
  manifest_type text not null,
  status text not null,
  note text not null,
  primary key (manifest_id),
  foreign key (planned_runner) references sql03_characters(character_id)
);
