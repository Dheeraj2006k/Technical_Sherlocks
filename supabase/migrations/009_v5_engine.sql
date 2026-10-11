-- 009_v5_engine.sql
-- PRD v5: registrations + manual assignment, case registry fields, investigation threads, hints, task attempts and
-- completions, two-component final deduction, story events, admin audit log, and per-table evidence keys.
--
-- Additive and forward-compatible: nothing from migrations 001-008 is dropped, so a populated v4 database upgrades in
-- place. The v4 gameplay tables (task_submissions, culprit_submission, task_assignments, case_query_keys) are left in
-- place but are no longer written by the application (see docs/DATABASE_MIGRATION.md).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Case registry (PRD 3)
-- ---------------------------------------------------------------------------------------------------------------
alter table cases add column game_track text not null default 'SQL' check (game_track in ('SQL', 'LOGIC'));
alter table cases add column target_duration_minutes int not null default 18 check (target_duration_minutes > 0);
alter table cases add column content_version int not null default 1 check (content_version > 0);
-- Final deduction base points (PRD 8). With the question base values they must total exactly 100 (validated per case).
alter table cases add column final_points_culprit int not null default 12 check (final_points_culprit >= 0);
alter table cases add column final_points_mechanism int not null default 8 check (final_points_mechanism >= 0);

update cases set status = 'published' where status in ('live', 'active');
alter table cases add constraint cases_status_check check (status in ('draft', 'tested', 'published', 'disabled'));

-- case_code is now the public catalogue code (SQL01..SQL10, LOG01..LOG10). Legacy random codes stay valid until reseeded.
alter table cases drop constraint cases_case_code_format;
alter table cases add constraint cases_case_code_format check (case_code ~ '^[A-Z0-9][A-Z0-9-]{2,15}$');

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Registration and manual assignment (PRD 4)
-- ---------------------------------------------------------------------------------------------------------------
create table registrations (
  id                  uuid primary key default gen_random_uuid(),
  registration_ref    text not null unique,            -- unique reference AND credential the head types (8 Crockford chars)
  team_ref            text not null,                    -- the team's registered name
  team_size           int  not null check (team_size between 1 and 3),
  registration_status text not null default 'registered' check (registration_status in ('registered', 'eligible', 'withdrawn')),
  created_at          timestamptz not null default now(),
  constraint registrations_ref_format check (registration_ref ~ '^[0-9A-HJKMNP-TV-Z]{8}$')
);

alter table teams add column registration_id uuid references registrations(id) on delete set null;
-- one team session per registration (a duplicate head join can never create a second team)
create unique index teams_one_per_registration on teams (registration_id) where registration_id is not null;

create table team_case_assignments (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  case_id         uuid not null references cases(id),
  team_id         uuid references teams(id) on delete set null,   -- linked in the same transaction that creates the team
  assigned_by     text not null,
  assigned_at     timestamptz not null default now(),
  status          text not null default 'assigned' check (status in ('assigned', 'started', 'completed', 'cancelled')),
  updated_at      timestamptz not null default now()
);
-- a registration, and a team, can each have at most one ACTIVE assignment
create unique index tca_one_active_per_registration on team_case_assignments (registration_id) where status in ('assigned', 'started');
create unique index tca_one_active_per_team on team_case_assignments (team_id) where team_id is not null and status in ('assigned', 'started');
create index tca_case_idx on team_case_assignments (case_id);

-- every administrative action that matters (assign, reassign, reset, delete, pause, import)
create table admin_audit (
  id              bigserial primary key,
  action          text not null,
  actor           text not null,
  registration_id uuid,
  team_id         uuid,
  case_id         uuid,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index admin_audit_created_idx on admin_audit (created_at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Investigation threads (PRD 6.3)
-- ---------------------------------------------------------------------------------------------------------------
create table investigation_threads (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references cases(id) on delete cascade,
  phase_number           int  not null check (phase_number between 1 and 3),
  position               int  not null default 1,
  title                  text not null,
  subject_character_id   uuid references characters(id) on delete set null,   -- null for an object, event or location
  intro_text             text,
  outcome_type           text not null default 'COMPLETED'
                           check (outcome_type in ('CLEARED', 'LEAD_DISCOVERED', 'REMAINS_PERSON_OF_INTEREST', 'COMPLETED')),
  outcome_text           text,                                                  -- story shown when the thread completes
  required               boolean not null default true,
  prerequisite_thread_id uuid references investigation_threads(id) on delete set null
);
create index investigation_threads_case_idx on investigation_threads (case_id, phase_number, position);

-- evidence a thread unlocks: when it becomes available, or when it is completed
create table thread_evidence_tables (
  thread_id        uuid not null references investigation_threads(id) on delete cascade,
  table_name       text not null,
  unlock_condition text not null default 'available' check (unlock_condition in ('available', 'complete')),
  primary key (thread_id, table_name)
);

create table team_thread_progress (
  team_id      uuid not null references teams(id) on delete cascade,
  thread_id    uuid not null references investigation_threads(id) on delete cascade,
  status       text not null default 'completed' check (status in ('in_progress', 'completed')),
  outcome_type text,
  completed_at timestamptz,
  primary key (team_id, thread_id)
);

-- the head may hand threads out to teammates; nothing ever depends on team size
create table thread_assignments (
  thread_id   uuid not null references investigation_threads(id) on delete cascade,
  team_id     uuid not null references teams(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  assigned_by uuid not null references players(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (thread_id, team_id)
);

-- story that unfolds when a thread (or a single question) is completed
create table story_events (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references cases(id) on delete cascade,
  trigger_thread_id uuid references investigation_threads(id) on delete cascade,
  trigger_task_id   uuid references tasks(id) on delete cascade,
  title             text not null,
  body              text not null,
  check (trigger_thread_id is not null or trigger_task_id is not null)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Questions, hints, attempts, completions (PRD 7)
-- ---------------------------------------------------------------------------------------------------------------
alter table tasks add column thread_id uuid references investigation_threads(id) on delete cascade;
alter table tasks add column position int not null default 1;
alter table tasks add column base_points int not null default 10 check (base_points >= 0);
-- reward for a correct answer by number of hints used (index 0 = no hints); explicit per question
alter table tasks add column reward_schedule int[] not null default '{10,8,6,4,2}';
create index tasks_thread_idx on tasks (thread_id, position);

create table task_hints (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references tasks(id) on delete cascade,
  position  int  not null check (position >= 1),
  hint_text text not null,
  unique (task_id, position)
);

-- hints are shared by the whole team; (team, task, position) is unique so opening one twice is a no-op
create table team_hint_usage (
  team_id   uuid not null references teams(id) on delete cascade,
  task_id   uuid not null references tasks(id) on delete cascade,
  position  int  not null check (position >= 1),
  opened_by uuid not null references players(id) on delete cascade,
  opened_at timestamptz not null default now(),
  primary key (team_id, task_id, position)
);

-- every committed answer, kept forever; deliberately NOT unique per (team, task)
create table task_attempts (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references tasks(id) on delete cascade,
  team_id         uuid not null references teams(id) on delete cascade,
  player_id       uuid not null references players(id) on delete cascade,
  submitted_value text not null,
  is_correct      boolean not null,
  hints_used      int not null default 0,
  points_awarded  int not null default 0,                -- negative for a penalised wrong answer
  idempotency_key text not null,
  submitted_at    timestamptz not null default now(),
  unique (team_id, idempotency_key)
);
create index task_attempts_team_task_idx on task_attempts (team_id, task_id, submitted_at);
create index task_attempts_player_time_idx on task_attempts (player_id, submitted_at desc);

-- one completion per (team, task): the only place task points are awarded
create table team_task_completions (
  team_id        uuid not null references teams(id) on delete cascade,
  task_id        uuid not null references tasks(id) on delete cascade,
  completed_by   uuid not null references players(id) on delete cascade,
  completed_at   timestamptz not null default now(),
  points_awarded int not null,
  primary key (team_id, task_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Two-component final deduction (PRD 8)
-- ---------------------------------------------------------------------------------------------------------------
create table final_options (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references cases(id) on delete cascade,
  component  text not null default 'mechanism' check (component = 'mechanism'),
  position   int  not null,
  label      text not null,
  is_correct boolean not null default false,
  unique (case_id, component, position)
);
-- exactly one correct explanation per case
create unique index final_options_one_correct on final_options (case_id, component) where is_correct;

create table final_attempts (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references teams(id) on delete cascade,
  component       text not null check (component in ('culprit', 'mechanism')),
  submitted_value text not null,
  is_correct      boolean not null,
  points_awarded  int not null default 0,
  idempotency_key text not null,
  submitted_at    timestamptz not null default now(),
  unique (team_id, idempotency_key)
);

create table team_final_completions (
  team_id        uuid not null references teams(id) on delete cascade,
  component      text not null check (component in ('culprit', 'mechanism')),
  points_awarded int not null,
  resolved_at    timestamptz not null default now(),
  primary key (team_id, component)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Scores (PRD 12) and per-table evidence keys (PRD 9.3, 11.1)
-- ---------------------------------------------------------------------------------------------------------------
alter table team_scores add column points_by_component jsonb not null default '{}'::jsonb;
alter table team_scores add column updated_at timestamptz not null default now();

-- One secret key per (case, evidence table). The server sets app.keys to the keys of the tables a team has unlocked;
-- each table's RLS policy holds only the SHA-256 of its own key, so a player can neither forge nor derive a locked table's
-- key. Server-only: RLS on, no grants to player_exec.
create table case_table_keys (
  case_id    uuid not null references cases(id) on delete cascade,
  table_name text not null,
  key        text not null,
  primary key (case_id, table_name)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Keep every public table unreachable through Supabase's public API
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all sequences in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    revoke all on all sequences in schema public from authenticated;
  end if;
end $$;
