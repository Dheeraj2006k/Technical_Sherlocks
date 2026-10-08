-- 003_team_state.sql
-- team_progress (current_phase + three cleared flags) cannot represent WAITING,
-- FINAL_DEDUCTION or FINISHED. Add an explicit server-owned state column.
-- current_phase is kept (1..3) and must agree with state for PHASE_n.

alter table team_progress
  add column state text not null default 'WAITING'
    check (state in ('WAITING', 'PHASE_1', 'PHASE_2', 'PHASE_3', 'FINAL_DEDUCTION', 'FINISHED'));

alter table team_progress
  add constraint team_progress_phase_range check (current_phase between 1 and 3),
  add constraint team_progress_state_phase_agree
    check (state not like 'PHASE\_%' or current_phase = substr(state, 7)::int);
