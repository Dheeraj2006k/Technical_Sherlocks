export type AnswerType = "SINGLE_CHARACTER" | "NUMBER" | "TIME" | "TEXT" | "CHOICE";
export type Role = "head" | "investigator";
export type Track = "SQL" | "LOGIC";
export type EvidenceKind = "PERSON" | "ACCESS" | "OBJECT" | "MESSAGE" | "TIME" | "MOTIVE";
export type OutcomeType = "CLEARED" | "LEAD_DISCOVERED" | "REMAINS_PERSON_OF_INTEREST" | "COMPLETED";

export type Player = { id: string; display_name: string; role: Role; online: boolean };

export type Hint = { position: number; text: string };
export type Question = {
  id: string;
  position: number;
  title: string | null;
  prompt_text: string;
  answer_type: AnswerType;
  options: { key: string; text: string }[] | null; // CHOICE questions only (never says which is right)
  kind: EvidenceKind | null;
  base_points: number;
  reward_schedule: number[];
  completed: boolean;
  points_awarded: number | null;
  answer: string | null; // only present once the team has completed the question
  hints_total: number;
  hints: Hint[];
  wrong_attempts: number;
};
export type Thread = {
  id: string;
  phase: number;
  position: number;
  title: string;
  subject_character_id: string | null;
  intro_text: string | null;
  required: boolean;
  done: boolean;
  outcome_type: OutcomeType | null;
  outcome_text: string | null;
  assigned_to: string | null;
  questions: Question[];
  tables: string[];
};
export type StoryEvent = { title: string; body: string };
export type RosterEntry = { id: string; name: string; role: string | null; profile: string | null };
export type Solution = { culprit: string | null; motive: string | null; method: string | null; chain: string[] };
export type FinalOption = { id: string; label: string };

export type GameState = {
  state: "WAITING" | "PHASE_1" | "PHASE_2" | "PHASE_3" | "FINAL_DEDUCTION" | "FINISHED";
  current_phase: number;
  team: { team_code: string; team_name: string; started_at: string; finished_at: string | null; elapsed_s: number };
  realtime_channel: string;
  paused: boolean;
  case: { code: string; title: string; hook_text: string | null; track: Track; target_minutes: number };
  me: { player_id: string; display_name: string; role: Role; tour_state: "completed" | "dismissed" | null };
  players: Player[];
  threads: Thread[];
  story: StoryEvent[];
  final: {
    culprit: { resolved: boolean; points: number; max: number };
    mechanism: { resolved: boolean; points: number; max: number; options: FinalOption[] };
    wrong_attempts: number;
  };
  solution: Solution | null;
  scores: { total_pts: number; by_component: Record<string, number> };
  narrative: { phase: number; name: string | null; clue_text: string | null }[];
  unlocked_tables: string[];
  roster: RosterEntry[];
};

export type ConnectionMode = "live" | "polling" | "reconnecting";
export type Notify = (tone: "success" | "error" | "info", text: string) => void;
export type ApiResult = { ok: boolean; status: number; data: Record<string, unknown>; retryAfter: number | null };
export type Act = (path: string, body?: unknown) => Promise<ApiResult>;
