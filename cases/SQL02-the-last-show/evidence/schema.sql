-- SQL02 evidence schema (create table statements only), imported from the supplied seed and schema files

create table sql02_characters (
  character_id text not null,
  display_name text not null,
  role text not null,
  public_profile text not null,
  primary key (character_id)
);

create table sql02_access_events (
  event_id text not null,
  event_time timestamp not null,
  credential_id text not null,
  assigned_character_id text,
  zone text not null,
  event_type text not null,
  note text not null,
  primary key (event_id),
  foreign key (assigned_character_id) references sql02_characters(character_id),
  check ((event_type = ANY (ARRAY['ENTRY'::text, 'EXIT'::text, 'DENIED'::text])))
);

create table sql02_cue_log (
  cue_event_id text not null,
  event_time timestamp not null,
  cue_code text not null,
  operator_id text not null,
  planned_item_id text not null,
  observed_item_id text not null,
  result text not null,
  note text not null,
  primary key (cue_event_id),
  foreign key (operator_id) references sql02_characters(character_id)
);

create table sql02_inventory_checks (
  check_id text not null,
  checked_at timestamp not null,
  location text not null,
  item_id text not null,
  item_label text not null,
  observed_condition text not null,
  checked_by text not null,
  note text not null,
  primary key (check_id),
  foreign key (checked_by) references sql02_characters(character_id)
);

create table sql02_messages (
  message_id text not null,
  sent_at timestamp not null,
  sender_id text not null,
  recipient_id text not null,
  channel text not null,
  subject text not null,
  body text not null,
  primary key (message_id),
  foreign key (recipient_id) references sql02_characters(character_id),
  foreign key (sender_id) references sql02_characters(character_id)
);

create table sql02_prop_movements (
  movement_id text not null,
  event_time timestamp not null,
  item_id text not null,
  item_label text not null,
  from_location text not null,
  to_location text not null,
  handled_by text not null,
  logged_by text not null,
  reason text not null,
  seal_status text not null,
  primary key (movement_id),
  foreign key (handled_by) references sql02_characters(character_id),
  foreign key (logged_by) references sql02_characters(character_id),
  check ((seal_status = ANY (ARRAY['SEALED'::text, 'OPEN'::text, 'NOT_APPLICABLE'::text])))
);

create table sql02_role_assignments (
  assignment_id text not null,
  character_id text not null,
  duty text not null,
  zone text not null,
  valid_from timestamp not null,
  valid_to timestamp not null,
  primary key (assignment_id),
  foreign key (character_id) references sql02_characters(character_id),
  check ((valid_to > valid_from))
);
