export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
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

// What the screening model returns per posting, before we attach source/track metadata.
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
  company: string;
  title: string;
  location: string;
  salary: string;
  sponsorship_verified: boolean;
  sponsorship_evidence: string;
}
