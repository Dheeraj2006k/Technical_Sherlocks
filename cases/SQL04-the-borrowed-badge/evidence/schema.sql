-- SQL04 evidence schema (create table statements only), imported from the supplied seed and schema files

create table sql04_characters (
  character_id text not null,
  display_name text not null,
  role text not null,
  public_description text not null,
  primary key (character_id)
);

create table sql04_archive_inventory (
  inventory_event_id text not null,
  event_at timestamp not null,
  item_id text not null,
  item_name text not null,
  location text not null,
  quantity integer not null,
  recorded_by text not null,
  event_type text not null,
  note text not null,
  primary key (inventory_event_id),
  foreign key (recorded_by) references sql04_characters(character_id),
  check ((quantity >= 0))
);

create table sql04_badge_registry (
  badge_id text not null,
  assigned_to text not null,
  badge_type text not null,
  status text not null,
  note text not null,
  primary key (badge_id),
  foreign key (assigned_to) references sql04_characters(character_id)
);

create table sql04_badge_custody (
  custody_id text not null,
  badge_id text not null,
  event_at timestamp not null,
  actor_id text not null,
  event_type text not null,
  from_location text not null,
  to_location text not null,
  note text not null,
  primary key (custody_id),
  foreign key (actor_id) references sql04_characters(character_id),
  foreign key (badge_id) references sql04_badge_registry(badge_id)
);

create table sql04_door_events (
  door_event_id text not null,
  event_at timestamp not null,
  door_name text not null,
  badge_id text not null,
  event_type text not null,
  result text not null,
  controller_note text not null,
  primary key (door_event_id),
  foreign key (badge_id) references sql04_badge_registry(badge_id)
);

create table sql04_equipment_requests (
  request_id text not null,
  requested_at timestamp not null,
  requester_id text not null,
  item_requested text not null,
  fulfilled_from text not null,
  fulfilled_at timestamp,
  fulfilled_by text,
  status text not null,
  note text not null,
  primary key (request_id),
  foreign key (fulfilled_by) references sql04_characters(character_id),
  foreign key (requester_id) references sql04_characters(character_id)
);

create table sql04_inventory_notes (
  note_id text not null,
  created_at timestamp not null,
  author_id text not null,
  subject_id text not null,
  note_status text not null,
  note_text text not null,
  primary key (note_id),
  foreign key (author_id) references sql04_characters(character_id)
);

create table sql04_messages (
  message_id text not null,
  sent_at timestamp not null,
  sender_id text not null,
  recipient_id text not null,
  channel text not null,
  message_text text not null,
  primary key (message_id),
  foreign key (recipient_id) references sql04_characters(character_id),
  foreign key (sender_id) references sql04_characters(character_id)
);
