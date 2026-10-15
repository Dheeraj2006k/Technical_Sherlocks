-- SQL01 evidence schema (create table statements only), imported from the supplied seed and schema files

create table building_access_points (
  access_point_id text not null,
  door_name text not null,
  access_method text not null,
  records_rfid boolean not null,
  camera_coverage text not null,
  notes text not null,
  primary key (access_point_id)
);

create table component_inventory (
  component_code text not null,
  component_name text not null,
  storage_location text not null,
  safe_to_use boolean not null,
  status text not null,
  last_checked_at timestamp not null,
  primary key (component_code)
);

create table corridor_camera_events (
  camera_event_id text not null,
  camera_at timestamp not null,
  camera_location text not null,
  event_type text not null,
  person_hint text not null,
  linked_reference text not null,
  primary key (camera_event_id)
);

create table equipment_checkout (
  checkout_id text not null,
  event_at timestamp not null,
  person_name text not null,
  item_name text not null,
  action text not null,
  destination text not null,
  primary key (checkout_id)
);

create table fest_activity_log (
  activity_id text not null,
  event_at timestamp not null,
  person_name text not null,
  activity text not null,
  location text not null,
  source_system text not null,
  primary key (activity_id)
);

create table initial_statements (
  statement_id text not null,
  person_name text not null,
  recorded_at timestamp not null,
  statement_text text not null,
  statement_type text not null,
  primary key (statement_id)
);

create table maintenance_reports (
  report_id text not null,
  reported_at timestamp not null,
  reported_by text not null,
  component_code text not null,
  severity text not null,
  report_text text not null,
  status text not null,
  primary key (report_id)
);

create table nikhil_device_activity (
  device_event_id text not null,
  event_at timestamp not null,
  person_name text not null,
  device_name text not null,
  event_type text not null,
  location text not null,
  primary key (device_event_id)
);

create table power_controller_log (
  controller_event_id text not null,
  controller_at timestamp not null,
  component_code text not null,
  event_type text not null,
  status text not null,
  actor_hint text not null,
  primary key (controller_event_id)
);

create table report_notifications (
  notification_id text not null,
  report_id text not null,
  recipient text not null,
  sent_at timestamp not null,
  delivery_status text not null,
  primary key (notification_id),
  foreign key (report_id) references maintenance_reports(report_id)
);

create table notification_activity (
  activity_id text not null,
  notification_id text not null,
  actor text not null,
  action text not null,
  event_at timestamp not null,
  primary key (activity_id),
  foreign key (notification_id) references report_notifications(notification_id)
);

create table rohit_fest_tasks (
  task_id text not null,
  task_at timestamp not null,
  assigned_to text not null,
  task_text text not null,
  task_status text not null,
  location text not null,
  primary key (task_id)
);

create table rohit_messages (
  message_id text not null,
  message_at timestamp not null,
  sender text not null,
  recipient text not null,
  message_text text not null,
  channel text not null,
  primary key (message_id)
);

create table security_configuration (
  config_id text not null,
  access_point_id text not null,
  config_key text not null,
  config_value text not null,
  primary key (config_id)
);

create table staff_directory (
  staff_id text not null,
  full_name text not null,
  role_title text not null,
  known_context text not null,
  primary key (staff_id)
);

create table team_members (
  member_id text not null,
  full_name text not null,
  team_name text not null,
  role_title text not null,
  primary key (member_id)
);

create table workshop_access_log (
  event_id text not null,
  event_at timestamp not null,
  person_name text not null,
  door_name text not null,
  direction text not null,
  credential text not null,
  primary key (event_id),
  check ((direction = ANY (ARRAY['ENTRY'::text, 'EXIT'::text])))
);
