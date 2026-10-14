-- 012: story visibility. Purely additive: two nullable text columns that carry the case's own phase names and the public
-- one-line profile of each person of interest, so the player-facing case file can show them. No existing row changes.
alter table case_phases add column if not exists phase_name text;
alter table characters add column if not exists public_profile text;
