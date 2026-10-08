-- 006_culprit_and_pause.sql
-- Stage 4 (culprit grading) and Stage 6 (emergency pause).

-- The correct culprit for each case. Server-only: never selected by any player-facing query.
alter table cases add column culprit_character_id uuid references characters(id) on delete set null;

-- Emergency pause: a team with paused_at set cannot query, submit or finish, and its timer is frozen.
-- paused_total accumulates completed pauses so elapsed time can be computed exactly.
alter table teams add column paused_at timestamptz;
alter table teams add column paused_total interval not null default interval '0';

-- Single-row switch so teams created while the whole game is paused start paused too.
create table game_control (
  id        int primary key default 1 check (id = 1),
  paused    boolean not null default false,
  paused_at timestamptz
);
insert into game_control (id) values (1);
alter table game_control enable row level security;

-- Leaderboard / admin dashboard read patterns.
create index teams_case_idx on teams (case_id);
create index task_submissions_team_idx on task_submissions (team_id, submitted_at);
create index query_logs_team_idx on query_logs (team_id, created_at desc);
