import { query } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";
import { formatCode } from "@/lib/codes";
import { requireSession } from "@/lib/session";

// One statement = one consistent snapshot. Everything derives from the session's team.
// Columns are listed explicitly: correct_answer, hint text that hasn't been opened, and final-option correctness are never
// selected for questions the team hasn't completed; thread/question content is limited to threads the team can work on.
const STATE_SQL = `
with b as (
  select t.id as team_id, t.case_id, t.team_code, t.team_name, t.started_at, t.finished_at, t.paused_at, t.realtime_token,
         tp.state, tp.current_phase,
         extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                             - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s,
         case tp.state when 'WAITING' then 0 when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end as reached
    from teams t join team_progress tp on tp.team_id = t.id
   where t.id = $1
),
th as (
  select it.*,
         (it.phase_number <= b.reached and (it.prerequisite_thread_id is null or exists (
            select 1 from team_thread_progress p
             where p.team_id = b.team_id and p.thread_id = it.prerequisite_thread_id and p.status = 'completed'))) as available,
         exists (select 1 from team_thread_progress p where p.team_id = b.team_id and p.thread_id = it.id and p.status = 'completed') as done
    from investigation_threads it join b on it.case_id = b.case_id
)
select b.realtime_token, b.team_code, b.team_name, b.started_at, b.finished_at, b.paused_at, b.elapsed_s, b.state, b.current_phase, b.reached,
       ca.title as case_title, ca.hook_text, ca.case_code, ca.game_track, ca.target_duration_minutes,
       ca.final_points_culprit, ca.final_points_mechanism,
       case when b.state = 'FINISHED' then jsonb_build_object(
              'culprit', (select name from characters where id = ca.culprit_character_id),
              'motive', ca.solution_motive, 'method', ca.solution_method,
              'chain', coalesce(ca.solution_chain, '[]'::jsonb)) end as solution,
       jsonb_build_object('total_pts', sc.total_pts, 'by_component', sc.points_by_component) as scores,
       (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role,
                                                     'online', coalesce(p.last_seen_at > now() - interval '45 seconds', false))
                                  order by (p.role = 'head') desc, p.display_name), '[]'::jsonb)
          from players p where p.team_id = b.team_id) as players,
       (select coalesce(jsonb_agg(jsonb_build_object('phase', cp.phase_number, 'clue_text', cp.clue_text)
                                  order by cp.phase_number), '[]'::jsonb)
          from case_phases cp where cp.case_id = b.case_id and cp.phase_number <= b.reached) as narrative,
       (select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name, 'role', ch.role_in_story) order by ch.name), '[]'::jsonb)
          from characters ch where ch.case_id = b.case_id and b.reached >= 1) as roster,
       (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', th.id, 'phase', th.phase_number, 'position', th.position, 'title', th.title,
                  'subject_character_id', th.subject_character_id, 'intro_text', th.intro_text, 'required', th.required,
                  'done', th.done, 'outcome_type', case when th.done then th.outcome_type end,
                  'outcome_text', case when th.done then th.outcome_text end,
                  'assigned_to', ta.player_id,
                  'questions', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'id', tk.id, 'position', tk.position, 'title', tk.title, 'prompt_text', tk.prompt_text,
                        'answer_type', tk.answer_type, 'kind', tk.evidence_kind, 'base_points', tk.base_points,
                        'reward_schedule', tk.reward_schedule,
                        'completed', (c.task_id is not null), 'points_awarded', c.points_awarded,
                        'answer', case when c.task_id is not null then
                                    case when tk.answer_type = 'SINGLE_CHARACTER'
                                         then (select c2.name from characters c2 where c2.id::text = tk.correct_answer)
                                         else tk.correct_answer end end,
                        'hints_total', (select count(*)::int from task_hints h where h.task_id = tk.id),
                        'hints', (select coalesce(jsonb_agg(jsonb_build_object('position', h.position, 'text', h.hint_text) order by h.position), '[]'::jsonb)
                                    from task_hints h join team_hint_usage u on u.task_id = h.task_id and u.position = h.position and u.team_id = b.team_id
                                   where h.task_id = tk.id),
                        'wrong_attempts', (select count(*)::int from task_attempts a where a.task_id = tk.id and a.team_id = b.team_id and not a.is_correct)
                      ) order by tk.position, tk.id), '[]'::jsonb)
                      from tasks tk left join team_task_completions c on c.task_id = tk.id and c.team_id = b.team_id
                     where tk.thread_id = th.id),
                  'tables', (select coalesce(jsonb_agg(te.table_name order by te.table_name), '[]'::jsonb)
                               from thread_evidence_tables te where te.thread_id = th.id
                                and ((te.unlock_condition = 'available') or th.done))
                ) order by th.phase_number, th.position), '[]'::jsonb)
          from th
          left join thread_assignments ta on ta.thread_id = th.id and ta.team_id = b.team_id
         where th.available) as threads,
       (select coalesce(array_agg(distinct u.name order by u.name), '{}')
          from (select unnest(cp.tables_unlocked) as name
                  from case_phases cp where cp.case_id = b.case_id and cp.phase_number <= b.reached
                union
                select te.table_name
                  from thread_evidence_tables te join th on th.id = te.thread_id
                 where (te.unlock_condition = 'available' and th.available) or (te.unlock_condition = 'complete' and th.done)) u) as unlocked_tables,
       (select coalesce(jsonb_agg(jsonb_build_object('title', se.title, 'body', se.body) order by se.id), '[]'::jsonb)
          from story_events se
         where se.case_id = b.case_id
           and ((se.trigger_thread_id is not null and exists (select 1 from th where th.id = se.trigger_thread_id and th.done))
             or (se.trigger_task_id is not null and exists (select 1 from team_task_completions c where c.team_id = b.team_id and c.task_id = se.trigger_task_id)))) as story,
       (select coalesce(jsonb_agg(jsonb_build_object('id', fo.id, 'label', fo.label) order by fo.position), '[]'::jsonb)
          from final_options fo where fo.case_id = b.case_id and fo.component = 'mechanism'
           and b.state in ('FINAL_DEDUCTION', 'FINISHED')) as mechanism_options,
       (select coalesce(jsonb_object_agg(f.component, f.points_awarded), '{}'::jsonb) from team_final_completions f where f.team_id = b.team_id) as final_done,
       (select count(*)::int from final_attempts fa where fa.team_id = b.team_id and not fa.is_correct) as final_wrong
  from b
  join cases ca on ca.id = b.case_id
  join team_scores sc on sc.team_id = b.team_id`;

export async function GET(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    // Presence: refresh last_seen at most every 10s per player (cheap, conditional write).
    await query(
      "update players set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '10 seconds')",
      [s.player_id],
    ).catch(() => {});
    const r = await query(STATE_SQL, [s.team_id]);
    const row = r.rows[0];
    if (!row) throw new HttpError(401, "Session no longer valid");
    const done = row.final_done as Record<string, number>;
    return json({
      state: row.state,
      current_phase: row.current_phase,
      team: { team_code: formatCode(row.team_code), team_name: row.team_name, started_at: row.started_at, finished_at: row.finished_at, elapsed_s: row.elapsed_s },
      realtime_channel: row.realtime_token,
      paused: row.paused_at !== null,
      case: { code: row.case_code, title: row.case_title, hook_text: row.hook_text, track: row.game_track, target_minutes: row.target_duration_minutes },
      me: { player_id: s.player_id, display_name: s.display_name, role: s.role },
      players: row.players,
      threads: row.threads,
      story: row.story,
      final: {
        culprit: { resolved: "culprit" in done, points: done.culprit ?? 0, max: row.final_points_culprit },
        mechanism: { resolved: "mechanism" in done, points: done.mechanism ?? 0, max: row.final_points_mechanism, options: row.mechanism_options },
        wrong_attempts: row.final_wrong,
      },
      solution: row.solution ?? null,
      scores: row.scores,
      narrative: row.narrative,
      unlocked_tables: row.unlocked_tables,
      roster: row.roster,
    });
  });
}
