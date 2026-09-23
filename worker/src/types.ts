export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
  /** Shared secret the tracker UI sends as `Authorization: Bearer <token>`. Unset = every API call is refused. */
  TRACKER_TOKEN: string;
  /** Override only for local testing against a mock (defaults to https://api.anthropic.com). */
  ANTHROPIC_BASE_URL?: string;
}

export type Track = "italy-remote" | "sponsorship";
export type Decision = "apply" | "review" | "skip";
export type Status =
  | "Pending Review"
  | "Approved to Apply"
  | "Applied"
  | "Interview"
  | "Rejected"
  | "Not Pursuing";

export const STATUSES: Status[] = [
  "Pending Review",
  "Approved to Apply",
  "Applied",
  "Interview",
  "Rejected",
  "Not Pursuing",
];
export const APPLIED_STATUSES: Status[] = ["Applied", "Interview", "Rejected", "Not Pursuing"];

export interface Posting {
  id: string;
  company: string;
  title: string;
  track: Track;
  location: string | null;
  source_url: string;
  salary: string | null;
  score: number;
  decision: Decision;
  confidence: "high" | "medium" | "low" | null;
  remote_eligibility: string | null;
  seniority_detected: string | null;
  matched_requirements: string[];
  gaps: string[];
  one_line_reason: string | null;
  tailored_summary: string | null;
  sponsorship_country: string | null;
  sponsorship_verified: boolean;
  sponsorship_evidence: string | null;
  status: Status;
  status_changed_at: string | null;
  date_found: string;
  tailored_cv_url: string | null;
  tailored_cv_filename: string | null;
}

/** What the screening model returns per posting. */
export interface ScreenResult {
  decision: Decision;
  score: number;
  confidence: "high" | "medium" | "low";
  hard_filter_failures: string[];
  remote_eligibility: "eligible" | "unclear" | "not_eligible";
  seniority_detected: string;
  matched_requirements: string[];
  gaps: string[];
  one_line_reason: string;
  tailoring_note: string;
  company: string;
  title: string;
  location: string;
  salary: string;
  sponsorship_country: string;
  sponsorship_verified: boolean;
  sponsorship_evidence: string;
}

export interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "error";
  postings_added: number;
  postings_evaluated: number;
  notes: string | null;
}

/** Streamed to the UI (NDJSON) during a manual run; also drives the run console. */
export type RunEvent =
  | { type: "start"; run_id: number; tracks: Track[] }
  | { type: "search"; track: Track; query: string; hits: number }
  | { type: "discovered"; track: Track; hits: number; job_pages: number; fresh: number }
  | {
      type: "candidate";
      track: Track;
      url: string;
      outcome: "added" | "screened" | "skipped" | "unverified" | "expired" | "error";
      detail: string;
      company?: string;
      title?: string;
      score?: number;
      decision?: Decision;
    }
  | { type: "done"; run_id: number; status: "ok" | "error"; evaluated: number; added: number; budget_used: number; notes: string[] }
  | { type: "error"; message: string; fatal?: boolean };
