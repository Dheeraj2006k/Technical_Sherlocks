import { query } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";
import { formatCode } from "@/lib/codes";
import { requireSession } from "@/lib/session";

// One statement = one consistent snapshot. Everything derives from the session's team.
// Columns are listed explicitly: correct_answer is never selected, and clue/table/task
// data is limited to phases the team has reached.
const STATE_SQL = `
with b as (
  select t.id as team_id, t.case_id, t.team_code, t.team_name, t.started_at, t.finished_at, t.paused_at, t.realtime_token,
         tp.state, tp.current_phase,
         extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                             - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s,
         case tp.state when 'WAITING' then 0 when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end as reached
    from teams t join team_progress tp on tp.team_id = t.id
   where t.id = $1
)
select b.realtime_token, b.team_code, b.team_name, b.started_at, b.finished_at, b.paused_at, b.elapsed_s, b.state, b.current_phase, b.reached,
       cs.chosen_character_id, cs.is_correct as culprit_correct,
       -- the resolution is selected ONLY for a team that named the culprit correctly
       case when cs.is_correct then jsonb_build_object(
              'culprit', (select name from characters where id = ca.culprit_character_id),
              'motive', ca.solution_motive, 'method', ca.solution_method,
              'chain', coalesce(ca.solution_chain, '[]'::jsonb)) end as solution,
       ca.title as case_title, ca.hook_text,
       jsonb_build_object('phase1_pts', sc.phase1_pts, 'phase2_pts', sc.phase2_pts, 'phase3_pts', sc.phase3_pts,
                          'culprit_pts', sc.culprit_pts, 'total_pts', sc.total_pts) as scores,
       (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role,
                                                     'online', coalesce(p.last_seen_at > now() - interval '45 seconds', false))
                                  order by (p.role = 'head') desc, p.display_name), '[]'::jsonb)
          from players p where p.team_id = b.team_id) as players,
       (select coalesce(jsonb_agg(jsonb_build_object('phase', cp.phase_number, 'clue_text', cp.clue_text)
                                  order by cp.phase_number), '[]'::jsonb)
          from case_phases cp where cp.case_id = b.case_id and cp.phase_number <= b.reached) as narrative,
       (select coalesce(array_agg(distinct u.name order by u.name), '{}')
          from case_phases cp cross join lateral unnest(cp.tables_unlocked) as u(name)
         where cp.case_id = b.case_id and cp.phase_number <= b.reached) as unlocked_tables,
       (select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name, 'role', ch.role_in_story) order by ch.name), '[]'::jsonb)
          from characters ch where ch.case_id = b.case_id and b.reached >= 1) as roster,
       (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', tk.id, 'difficulty', tk.difficulty, 'prompt_text', tk.prompt_text,
                  'answer_type', tk.answer_type, 'title', tk.title, 'kind', tk.evidence_kind,
                  'assigned_to', ta.player_id, 'assigned_by', ta.assigned_by,
                  'solved', exists (select 1 from task_submissions s
                                     where s.task_id = tk.id and s.team_id = b.team_id and s.is_correct))
                order by case tk.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end, tk.id), '[]'::jsonb)
          from tasks tk
          left join task_assignments ta on ta.task_id = tk.id and ta.team_id = b.team_id
         where tk.case_id = b.case_id and b.state in ('PHASE_1', 'PHASE_2', 'PHASE_3')
           and tk.phase_number = b.current_phase) as tasks,
       -- evidence board: ONLY tasks this team has already solved (their verified answer), in reached phases
       (select coalesce(jsonb_agg(jsonb_build_object(
                  'task_id', tk.id, 'phase', tk.phase_number, 'title', tk.title, 'kind', tk.evidence_kind,
                  'label', tk.evidence_label, 'answer_type', tk.answer_type,
                  'value', case when tk.answer_type = 'SINGLE_CHARACTER'
                               then (select c2.name from characters c2 where c2.id::text = tk.correct_answer)
                               else tk.correct_answer end)
                order by tk.phase_number, case tk.difficulty when 'easy' then 1 when 'medium' then 2 else 3 end), '[]'::jsonb)
          from tasks tk
         where tk.case_id = b.case_id and tk.phase_number <= b.reached
           and exists (select 1 from task_submissions s
                        where s.task_id = tk.id and s.team_id = b.team_id and s.is_correct)) as evidence
  from b
  join cases ca on ca.id = b.case_id
  join team_scores sc on sc.team_id = b.team_id
  left join culprit_submission cs on cs.team_id = b.team_id`;

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
    return json({
      state: row.state,
      current_phase: row.current_phase,
      team: { team_code: formatCode(row.team_code), team_name: row.team_name, started_at: row.started_at, finished_at: row.finished_at, elapsed_s: row.elapsed_s },
      realtime_channel: row.realtime_token,
      paused: row.paused_at !== null,
      culprit: row.chosen_character_id ? { submitted: true, correct: row.culprit_correct, chosen_character_id: row.chosen_character_id } : { submitted: false },
      case: { title: row.case_title, hook_text: row.hook_text },
      me: { player_id: s.player_id, display_name: s.display_name, role: s.role },
      players: row.players,
      tasks: row.tasks,
      evidence: row.evidence,
      solution: row.solution ?? null,
      scores: row.scores,
      narrative: row.narrative,
      unlocked_tables: row.unlocked_tables,
      roster: row.roster,
    });
  });
}
