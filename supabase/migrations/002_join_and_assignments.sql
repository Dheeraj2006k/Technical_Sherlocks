-- 002_join_and_assignments.sql
-- Stage 1/2: per-team unique display names, task assignments, join idempotency.

alter table players add constraint players_team_display_name_key unique (team_id, display_name);

create table task_assignments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  team_id     uuid not null references teams(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  assigned_by uuid not null references players(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  unique (task_id, team_id)
);

create table join_requests (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  team_id         uuid not null references teams(id) on delete cascade,
  player_id       uuid not null references players(id) on delete cascade,
  created_at      timestamptz not null default now()
);
