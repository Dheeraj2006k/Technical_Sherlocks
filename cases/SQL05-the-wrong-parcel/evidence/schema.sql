-- SQL05 evidence schema (create table statements only), imported from the supplied seed and schema files

create table sql05_characters (
  character_id text not null,
  display_name text not null,
  role text not null,
  primary key (character_id)
);

create table sql05_messages (
  message_id text not null,
  sent_at timestamp not null,
  sender_id text not null,
  recipient_id text not null,
  message_text text not null,
  primary key (message_id),
  foreign key (recipient_id) references sql05_characters(character_id),
  foreign key (sender_id) references sql05_characters(character_id)
);

create table sql05_parcels (
  parcel_id text not null,
  packed_contents text not null,
  intended_destination text not null,
  packed_at timestamp not null,
  packed_by text not null,
  note text not null,
  primary key (parcel_id),
  foreign key (packed_by) references sql05_characters(character_id)
);

create table sql05_delivery_expectations (
  expectation_id text not null,
  created_at timestamp not null,
  requested_by text not null,
  parcel_id text not null,
  expected_contents text not null,
  expected_destination text not null,
  priority text not null,
  primary key (expectation_id),
  foreign key (parcel_id) references sql05_parcels(parcel_id),
  foreign key (requested_by) references sql05_characters(character_id)
);

create table sql05_label_audit (
  audit_id text not null,
  parcel_id text not null,
  event_at timestamp not null,
  actor_id text not null,
  field_changed text not null,
  old_value text not null,
  new_value text not null,
  reason text not null,
  primary key (audit_id),
  foreign key (actor_id) references sql05_characters(character_id),
  foreign key (parcel_id) references sql05_parcels(parcel_id)
);

create table sql05_receipts (
  receipt_id text not null,
  parcel_id text not null,
  received_at timestamp not null,
  received_by text not null,
  destination text not null,
  contents_observed text not null,
  note text not null,
  primary key (receipt_id),
  foreign key (parcel_id) references sql05_parcels(parcel_id),
  foreign key (received_by) references sql05_characters(character_id)
);

create table sql05_route_scans (
  scan_id text not null,
  parcel_id text not null,
  event_at timestamp not null,
  scan_location text not null,
  scan_type text not null,
  scanned_label_destination text not null,
  note text not null,
  primary key (scan_id),
  foreign key (parcel_id) references sql05_parcels(parcel_id)
);
