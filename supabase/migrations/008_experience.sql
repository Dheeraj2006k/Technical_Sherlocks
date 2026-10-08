-- 008_experience.sql
-- Data the redesigned experience needs: player presence, task titles + evidence-board metadata, and the
-- case resolution (motive / method / evidence chain) revealed ONLY to a team that names the culprit.

alter table players add column last_seen_at timestamptz;

alter table tasks add column title text;
alter table tasks add column evidence_kind text
  check (evidence_kind is null or evidence_kind in ('PERSON', 'ACCESS', 'OBJECT', 'MESSAGE', 'TIME', 'MOTIVE'));
-- Sentence shown on the evidence board once the task is solved; "{value}" is replaced by the verified answer.
alter table tasks add column evidence_label text;

alter table cases add column solution_motive text;
alter table cases add column solution_method text;
alter table cases add column solution_chain jsonb;
