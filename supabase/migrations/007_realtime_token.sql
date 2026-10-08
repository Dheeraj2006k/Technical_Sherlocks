-- 007_realtime_token.sql
-- Stage 5: one Supabase Realtime broadcast channel per team. The channel name is a random,
-- unguessable token (not the team id or team code). Pings carry no data: clients refetch /api/state.
alter table teams add column realtime_token text not null default encode(gen_random_bytes(16), 'hex');
create unique index teams_realtime_token_key on teams (realtime_token);
