export type AnswerType = "SINGLE_CHARACTER" | "NUMBER" | "TIME" | "TEXT";
export type Role = "head" | "investigator";
export type EvidenceKind = "PERSON" | "ACCESS" | "OBJECT" | "MESSAGE" | "TIME" | "MOTIVE";

export type Player = { id: string; display_name: string; role: Role; online: boolean };
export type Task = {
  id: string;
  difficulty: string | null;
  prompt_text: string;
  answer_type: AnswerType;
  title: string | null;
  kind: EvidenceKind | null;
  assigned_to: string | null;
  assigned_by: string | null;
  solved: boolean;
};
export type Evidence = {
  task_id: string;
  phase: number;
  title: string | null;
  kind: EvidenceKind | null;
  label: string | null;
  answer_type: AnswerType;
  value: string;
};
export type RosterEntry = { id: string; name: string; role: string | null };
export type Solution = { culprit: string | null; motive: string | null; method: string | null; chain: string[] };

export type GameState = {
  state: "WAITING" | "PHASE_1" | "PHASE_2" | "PHASE_3" | "FINAL_DEDUCTION" | "FINISHED";
  current_phase: number;
  team: { team_code: string; team_name: string; started_at: string; finished_at: string | null; elapsed_s: number };
  realtime_channel: string;
  paused: boolean;
  culprit: { submitted: boolean; correct?: boolean; chosen_character_id?: string };
  case: { title: string; hook_text: string | null };
  me: { player_id: string; display_name: string; role: Role };
  players: Player[];
  tasks: Task[];
  evidence: Evidence[];
  solution: Solution | null;
  scores: { phase1_pts: number; phase2_pts: number; phase3_pts: number; culprit_pts: number; total_pts: number };
  narrative: { phase: number; clue_text: string | null }[];
  unlocked_tables: string[];
  roster: RosterEntry[];
};

export type ConnectionMode = "live" | "polling" | "reconnecting";
export type Notify = (tone: "success" | "error" | "info", text: string) => void;
export type ApiResult = { ok: boolean; status: number; data: Record<string, unknown>; retryAfter: number | null };
export type Act = (path: string, body?: unknown) => Promise<ApiResult>;
