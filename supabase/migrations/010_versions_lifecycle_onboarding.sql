-- 010_versions_lifecycle_onboarding.sql
-- PRD Addendum 1 + section 17. Additive and backward compatible: nothing from 001-009 is dropped or rewritten.
--
--  1. Case content versions: one `cases` row per (case_code, content_version). A team's case_id therefore IS its pinned version.
--  2. Publication lifecycle: draft -> review -> tested -> published, plus disabled (no new assignments, existing sessions go on).
--  3. Pinning: a team records the code/version it started on; its case cannot change after it has started; the content of a
--     case that any team references (questions, hints, threads, unlocks, final options, story, roster) becomes immutable.
--  4. Per-player onboarding state (guided tour), separate from every game table.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Versions
-- ---------------------------------------------------------------------------------------------------------------
alter table cases drop constraint if exists cases_case_code_key;
alter table cases add constraint cases_code_version_key unique (case_code, content_version);
-- at most one published version per catalogue code (publishing a new version disables the previous one first)
create unique index cases_one_published_per_code on cases (case_code) where status = 'published';

-- Which exact bytes of the case pack this row was built from, which hash passed the automated gate, and the human record.
alter table cases add column content_hash   text check (content_hash   is null or content_hash   ~ '^[0-9a-f]{64}$');
alter table cases add column validated_hash text check (validated_hash is null or validated_hash ~ '^[0-9a-f]{64}$');
alter table cases add column tested_hash    text check (tested_hash    is null or tested_hash    ~ '^[0-9a-f]{64}$');
alter table cases add column review_record  jsonb not null default '{}'::jsonb;   -- reviewer / blind-playtest attestation (never answers)
alter table cases add column published_at   timestamptz;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Lifecycle
-- ---------------------------------------------------------------------------------------------------------------
alter table cases drop constraint cases_status_check;
alter table cases add constraint cases_status_check check (status in ('draft', 'review', 'tested', 'published', 'disabled'));

-- The only sanctioned way to move a pack-managed case between states. Legacy / test rows (content_hash is null) are not
-- constrained by the evidence gates, so older tooling keeps working; pack-managed rows cannot skip a gate.
create or replace function transition_case_status(p_case_id uuid, p_to text, p_actor text, p_record jsonb default '{}'::jsonb)
returns text language plpgsql as $$
declare c cases%rowtype; allowed boolean;
begin
  select * into c from cases where id = p_case_id for update;
  if not found then raise exception 'case not found'; end if;
  if c.status = p_to then return c.status; end if;
  allowed := (c.status, p_to) in (
    ('draft', 'review'), ('review', 'draft'), ('review', 'tested'), ('tested', 'review'), ('tested', 'published'),
    ('draft', 'disabled'), ('review', 'disabled'), ('tested', 'disabled'), ('published', 'disabled'), ('disabled', 'review'));
  if not allowed then raise exception 'illegal case status transition % -> %', c.status, p_to; end if;
  if c.content_hash is not null then
    if p_to = 'review' and c.status = 'draft' and c.validated_hash is distinct from c.content_hash then
      raise exception 'automated validation has not passed for this exact content version';
    end if;
    if p_to = 'tested' then
      if coalesce(p_record->>'reviewer', '') = '' or coalesce(p_record->>'blind_playtest', '') <> 'completed' then
        raise exception 'tested requires a named human reviewer and a completed blind playtest of this exact version';
      end if;
      update cases set tested_hash = c.content_hash, review_record = c.review_record || p_record || jsonb_build_object('tested_at', now()) where id = c.id;
    end if;
    if p_to = 'published' and (c.tested_hash is distinct from c.content_hash or c.validated_hash is distinct from c.content_hash) then
      raise exception 'only the exact version that was validated and tested can be published';
    end if;
  end if;
  if p_to = 'published' then
    update cases set status = 'disabled' where case_code = c.case_code and status = 'published' and id <> c.id;
    update cases set published_at = now() where id = c.id;
  end if;
  update cases set status = p_to where id = c.id;
  insert into admin_audit (action, actor, case_id, details)
  values ('case_status_changed', p_actor, c.id, jsonb_build_object('case_code', c.case_code, 'content_version', c.content_version, 'from', c.status, 'to', p_to));
  return p_to;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Pinning and immutability
-- ---------------------------------------------------------------------------------------------------------------
alter table teams add column pinned_case_code text;
alter table teams add column pinned_content_version int;
update teams t set pinned_case_code = c.case_code, pinned_content_version = c.content_version from cases c where c.id = t.case_id;

create or replace function teams_pin_version() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.case_id is distinct from old.case_id
     and exists (select 1 from team_progress tp where tp.team_id = new.id and tp.state <> 'WAITING') then
    raise exception 'a team that has started stays pinned to its content version (reset the team first)';
  end if;
  select c.case_code, c.content_version into new.pinned_case_code, new.pinned_content_version from cases c where c.id = new.case_id;
  return new;
end $$;
create trigger teams_pin_version before insert or update of case_id on teams for each row execute function teams_pin_version();

-- Once any team references a case, its game content is frozen: a change must be published as a new content version.
create or replace function guard_case_content() returns trigger language plpgsql as $$
declare cid uuid; r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if tg_table_name = 'task_hints' then
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

do $$
declare t text;
begin
  foreach t in array array['case_phases', 'characters', 'tasks', 'task_hints', 'investigation_threads', 'thread_evidence_tables', 'story_events', 'final_options'] loop
    execute format('create trigger guard_content before insert or update or delete on %I for each row execute function guard_case_content()', t);
  end loop;
end $$;

-- The case row itself: operational columns (status, password hash, review fields) stay editable; game content does not.
create or replace function guard_case_row() returns trigger language plpgsql as $$
begin
  if exists (select 1 from teams where case_id = old.id) and (
       new.title is distinct from old.title or new.hook_text is distinct from old.hook_text or new.slug is distinct from old.slug
    or new.case_code is distinct from old.case_code or new.content_version is distinct from old.content_version
    or new.game_track is distinct from old.game_track or new.target_duration_minutes is distinct from old.target_duration_minutes
    or new.final_points_culprit is distinct from old.final_points_culprit or new.final_points_mechanism is distinct from old.final_points_mechanism
    or new.culprit_character_id is distinct from old.culprit_character_id or new.solution_motive is distinct from old.solution_motive
    or new.solution_method is distinct from old.solution_method or new.solution_chain is distinct from old.solution_chain
    or new.content_hash is distinct from old.content_hash) then
    raise exception 'case content is pinned by live teams: publish a new content version instead';
  end if;
  return new;
end $$;
create trigger guard_case_row before update on cases for each row execute function guard_case_row();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Per-player onboarding (guided tour). Deliberately on the player, not the team, and not on any scoring table.
-- ---------------------------------------------------------------------------------------------------------------
alter table players add column tour_state text check (tour_state is null or tour_state in ('completed', 'dismissed'));
alter table players add column tour_updated_at timestamptz;
