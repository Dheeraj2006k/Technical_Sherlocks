-- 001_core_schema.sql
-- Core schema per PRD section 7. No RLS yet (added in a later stage).
-- Per-case clue data tables are NOT part of this migration.

create extension if not exists pgcrypto;

create table cases (
  id            uuid primary key default gen_random_uuid(),
  password_hash text not null,
  title         text not null,
  status        text not null default 'draft',
  hook_text     text
);

create table case_phases (
  case_id         uuid not null references cases(id) on delete cascade,
  phase_number    int  not null check (phase_number between 1 and 3),
  clue_text       text,
  tables_unlocked text[] not null default '{}',
  primary key (case_id, phase_number)
);

create table tasks (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references cases(id) on delete cascade,
  phase_number   int  not null check (phase_number between 1 and 3),
  difficulty     text,
  prompt_text    text not null,
  answer_type    text not null,
  correct_answer text not null,
  sql_concept    text,
  foreign key (case_id, phase_number) references case_phases(case_id, phase_number) on delete cascade
);

create table characters (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references cases(id) on delete cascade,
  name          text not null,
  role_in_story text
);

create table teams (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references cases(id),
  team_code   text not null unique,
  team_name   text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create table players (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references teams(id) on delete cascade,
  display_name text not null,
  role         text not null check (role in ('head', 'investigator'))
);

-- Only one head per team.
create unique index players_one_head_per_team on players (team_id) where role = 'head';

create table task_submissions (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references tasks(id),
  team_id         uuid not null references teams(id) on delete cascade,
  player_id       uuid not null references players(id),
  submitted_value text not null,
  is_correct      boolean not null,
  submitted_at    timestamptz not null default now()
);

-- A team can have at most one correct submission per task.
create unique index task_submissions_one_correct on task_submissions (task_id, team_id) where is_correct;

create table team_progress (
  team_id        uuid primary key references teams(id) on delete cascade,
  current_phase  int not null default 1,
  phase1_cleared boolean not null default false,
  phase2_cleared boolean not null default false,
  phase3_cleared boolean not null default false
);

create table team_scores (
  team_id     uuid primary key references teams(id) on delete cascade,
  phase1_pts  int not null default 0,
  phase2_pts  int not null default 0,
  phase3_pts  int not null default 0,
  culprit_pts int not null default 0,
  total_pts   int not null default 0
);

create table culprit_submission (
  team_id             uuid not null unique references teams(id) on delete cascade,
  chosen_character_id uuid not null references characters(id),
  is_correct          boolean not null,
  submitted_at        timestamptz not null default now()
);

create table query_logs (
  id                uuid primary key default gen_random_uuid(),
  team_id           uuid not null references teams(id) on delete cascade,
  player_id         uuid references players(id) on delete set null,
  query_hash        text not null,
  execution_time_ms int,
  row_count         int,
  success           boolean not null,
  error_type        text,
  created_at        timestamptz not null default now()
);

-- Rate limiting counts recent rows per player (CLAUDE.md amendment).
create index query_logs_player_created_idx on query_logs (player_id, created_at desc);
