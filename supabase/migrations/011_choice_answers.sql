-- 011_choice_answers.sql
-- Multiple-choice questions (answer_type CHOICE), extra accepted wordings for exact answers, and an explicit suspect list.
-- Additive: nothing from 001-010 changes meaning. Applied after 010 and before the authored case versions are seeded.
--
--  * tasks.alt_answers   other exact wordings accepted for a typed answer (still exact-match grading, no fuzzy logic)
--  * task_options        the 2-6 labelled options of a CHOICE question; correct_answer holds the correct option KEY and the
--                        option rows never say which one is right (the key lives only in tasks, which players cannot read)
--  * characters.is_suspect  whether the person appears in the final "who is responsible" list (default: yes)

alter table tasks add column alt_answers text[] not null default '{}';

create table task_options (
  task_id     uuid not null references tasks(id) on delete cascade,
  option_key  text not null check (option_key ~ '^[A-Za-z0-9]{1,8}$'),
  option_text text not null,
  position    int  not null check (position >= 1),
  primary key (task_id, option_key),
  unique (task_id, position)
);
alter table task_options enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table task_options from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table task_options from authenticated; end if;
end $$;

alter table characters add column is_suspect boolean not null default true;

-- extend the content-freeze guard from 010 to the new table
create or replace function guard_case_content() returns trigger language plpgsql as $$
declare cid uuid; r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if tg_table_name = 'task_hints' or tg_table_name = 'task_options' then
    select t.case_id into cid from tasks t where t.id = r.task_id;
  elsif tg_table_name = 'thread_evidence_tables' then
    select t.case_id into cid from investigation_threads t where t.id = r.thread_id;
  else
    cid := r.case_id;
  end if;
  if cid is not null and exists (select 1 from teams where case_id = cid) then
    raise exception 'case content is pinned by live teams (table %): publish a new content version instead', tg_table_name;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_content before insert or update or delete on task_options for each row execute function guard_case_content();
