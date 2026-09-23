// Deterministic guardrails around the model: cheap pre-filters that avoid paying
// for a Claude call on obvious non-starters, and hard checks on what the model
// returns so a hallucinated "verified sponsorship" can never reach the tracker.

import type { Decision, ScreenResult, Track } from "./types";

const EUROPE_SIGNAL = /\b(italy|italia|italian|europe|european|emea|eea|eu[- ]based|remote[- ]?eu|worldwide|anywhere in the world|global(?:ly)? remote|work from anywhere|fully distributed)\b|\beu\b/i;
const US_ONLY =
  /\b(u\.?s\.?[- ]only|united states only|us[- ]based only|remote[,\s(-]+(?:us|usa|u\.s\.|united states)\b|must (?:be|reside|live)[^.]{0,60}(?:united states|u\.s\.)|(?:authorized|eligible|legally entitled) to work in the (?:united states|u\.s\.|us)\b|us work authorization|(?:united states|u\.s\.) citizen)/i;
const CANADA_ONLY = /\b(remote[,\s(-]+canada\b|canada[- ]only|must (?:be|reside|live)[^.]{0,60}canada|authorized to work in canada)\b/i;
const SPONSOR_SIGNAL = /\b(sponsor\w*|visa\w*|relocat\w*|work permit|blue card|immigration|right to work)\b/i;

/** A reason to skip the Claude call entirely, or null to proceed to screening. */
export function quickReject(track: Track, text: string): string | null {
  if (text.length < 400) return "posting text too short to judge (likely an error/closed page)";
  if (track === "sponsorship") {
    // Sponsorship must be quoted from the posting itself; no sponsorship language = cannot ever qualify.
    if (!SPONSOR_SIGNAL.test(text)) return "no visa/sponsorship/relocation language in the posting";
    return null;
  }
  if (!EUROPE_SIGNAL.test(text)) {
    if (US_ONLY.test(text)) return "US-only posting with no Europe/Italy/EMEA eligibility";
    if (CANADA_ONLY.test(text)) return "Canada-only posting with no Europe/Italy/EMEA eligibility";
  }
  return null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The quoted sponsorship sentence must literally appear in the fetched posting.
 * (Ellipsis-joined quotes are checked piece by piece.) This is what makes
 * "sponsorship verified" a checkable claim rather than the model's say-so.
 */
export function evidenceInText(evidence: string, text: string): boolean {
  const e = norm(evidence).replace(/^["'“”]+|["'“”]+$/g, "");
  if (e.length < 20) return false;
  const hay = norm(text);
  const parts = e.split(/…|\.\.\./).map((p) => p.trim()).filter((p) => p.length >= 15);
  return parts.length > 0 && parts.every((p) => hay.includes(p));
}

const APPLY_MIN = 75;
const FLOOR: Record<Track, number> = { "italy-remote": 55, sponsorship: 60 };

export interface Judged {
  result: ScreenResult;
  decision: Decision;
  qualifies: boolean;
  sponsorshipVerified: boolean;
}

/** Re-derive the decision in code from the score, hard filters and (for sponsorship) checked evidence. */
export function judge(track: Track, result: ScreenResult, postingText: string): Judged {
  let sponsorshipVerified = false;
  if (track === "sponsorship") {
    sponsorshipVerified = result.sponsorship_verified && evidenceInText(result.sponsorship_evidence, postingText);
  }

  let decision: Decision;
  if (result.hard_filter_failures.length > 0 || (track === "italy-remote" && result.remote_eligibility === "not_eligible")) {
    decision = "skip";
  } else if (track === "sponsorship" && !sponsorshipVerified) {
    decision = "skip";
  } else if (result.score >= APPLY_MIN) {
    decision = "apply";
  } else if (result.score >= FLOOR[track]) {
    decision = "review";
  } else {
    decision = "skip";
  }
  return { result, decision, qualifies: decision !== "skip", sponsorshipVerified };
}
