// Deterministic guardrails around the model: cheap pre-filters that avoid paying
// for a Claude call on obvious non-starters, and hard checks on what the model
// returns so a hallucinated "verified sponsorship" can never reach the tracker.

import type { Decision, ScreenResult, Track } from "./types";

const EUROPE_SIGNAL = /\b(italy|italia|italian|europe|european|emea|eea|eu[- ]based|remote[- ]?eu|worldwide|anywhere in the world|global(?:ly)? remote|work from anywhere|fully distributed)\b|\beu\b/i;
const US_ONLY =
  /\b(u\.?s\.?[- ]only|united states only|us[- ]based only|remote[,\s(-]+(?:us|usa|u\.s\.|united states)\b|must (?:be|reside|live)[^.]{0,60}(?:united states|u\.s\.)|(?:authorized|eligible|legally entitled) to work in the (?:united states|u\.s\.|us)\b|us work authorization|(?:united states|u\.s\.) citizen)/i;
const CANADA_ONLY = /\b(remote[,\s(-]+canada\b|canada[- ]only|must (?:be|reside|live)[^.]{0,60}canada|authorized to work in canada)\b/i;
const REMOTE_SIGNAL = /\bremote(?:ly)?\b|work(?:ing)? from (?:home|anywhere)|\bwfh\b|home[- ]?office|tele(?:work|commut)|smart[- ]?working|lavoro (?:da )?remoto|distributed team|fully distributed|virtual (?:position|role)/i;
// Explicit denials ("we do not sponsor", "Visa Sponsorship Available: No", "unable to consider candidates who require sponsorship").
const SPONSOR_DENIED =
  /\b(?:do(?:es)? not|don'?t|doesn'?t|cannot|can'?t|unable to|not able to|will not|won'?t|not (?:currently )?in a position to)\s+(?:offer\s+|provide\s+|consider\s+(?:candidates\s+)?(?:who\s+)?(?:require\s+)?)?(?:visa\s+|immigration\s+|employment\s+)?sponsor|sponsorship\s+available:?\s*no\b|(?:no|without)\s+(?:visa\s+|immigration\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)|unable to consider candidates who require|not eligible for (?:visa\s+)?sponsorship/i;
// Anything that reads as offering sponsorship or relocation help.
const SPONSOR_OFFERED =
  /\bwe\s+(?:do\s+|will\s+|can\s+|are able to\s+|are happy to\s+)?sponsor\b|\bwill\s+sponsor\b|\bcan\s+sponsor\b|\bsponsorship\s+(?:is\s+)?(?:available|provided|offered)\s*(?!:?\s*no\b)|\boffer(?:s)?\s+(?:visa\s+)?sponsorship|\brelocation\s+(?:assistance|package|support|budget|bonus|benefits?|allowance)|\bhelp(?:s)?\s+with\s+(?:your\s+)?(?:visa|relocation)|\bvisa\s+support\b|\bvisa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered)\b(?!:?\s*no\b)|\bsponsorship\s+available:?\s*yes\b/i;
const SPONSOR_SIGNAL = /\b(sponsor\w*|visa\w*|relocat\w*|work permit|blue card|immigration|right to work)\b/i;

/** A reason to skip the Claude call entirely, or null to proceed to screening. */
export function quickReject(track: Track, text: string, opts: { remoteBoard?: boolean } = {}): string | null {
  if (text.length < 400) return "posting text too short to judge (likely an error/closed page)";
  if (track === "sponsorship") {
    // Sponsorship must be quoted from the posting itself; no sponsorship language = cannot ever qualify.
    if (!SPONSOR_SIGNAL.test(text)) return "no visa/sponsorship/relocation language in the posting";
    if (SPONSOR_DENIED.test(text) && !SPONSOR_OFFERED.test(text)) return "the posting explicitly says it does not sponsor";
    return null;
  }
  // An on-site or hybrid role that never says "remote" anywhere cannot be worked from Italy (remote job boards are exempt: remote is their premise).
  if (!opts.remoteBoard && !REMOTE_SIGNAL.test(text)) return "no remote-work language anywhere in the posting (on-site or hybrid role)";
  if (!EUROPE_SIGNAL.test(text)) {
    if (US_ONLY.test(text)) return "US-only posting with no Europe/Italy/EMEA eligibility";
    if (CANADA_ONLY.test(text)) return "Canada-only posting with no Europe/Italy/EMEA eligibility";
  }
  return null;
}

// ---- cheap title triage (before any fetch or Claude call) ----------------------------------------
const TITLE_POS =
  /security|secops|devsecops|cyber|infosec|iam\b|identity|access management|compliance|grc\b|governance|risk|audit|privacy|soc\b|incident|threat|vulnerab|cloud|sre\b|reliability|devops|platform|infrastructure|network|firewall|zero trust|kubernetes|pki|crypto|sysadmin|systems? admin|it operations/i;
const TITLE_STRONG = /security|secops|cyber|infosec|iam\b|identity|compliance|grc\b|privacy|soc\b|incident|threat|vulnerab/i;
// Roles that are never a fit, however "secure" the title sounds (e.g. "Sales Manager - GRC Europe", "SAP GRC Consultant").
const TITLE_HARD_NEG =
  /\b(sales|account (executive|manager)|business development|marketing|recruit(er|ing)|talent|hr|human resources|payroll|accountant|legal|counsel|paralegal|designer|copywriter|customer success|technical writer|product (manager|owner)|advocate|sap|salesforce|erp|solutions? architect|solutions? engineer|field engineer|professional services|customer engineer|technical account|pre-?sales|engineering manager|delivery manager|program manager|project manager|community manager|people manager|physical security|security guard|security officer \(?(?:site|building|campus)|facilit(?:y|ies)|health (?:and|&) safety|\behs\b|\bhse\b|food safety)\b/i;
// Other engineering specialisms: only a reason to skip when nothing security-shaped is in the title.
const TITLE_SOFT_NEG = /\b(scrum|front-?end|back-?end|full[- ]?stack|data (scientist|analyst|engineer)|machine learning|ios|android|mobile|qa|tester|game|unity|finance|support engineer)\b/i;

/** A reason to skip a posting on its title alone, or null. Conservative: uninformative titles pass through. */
export function titleTriage(title: string, context = ""): string | null {
  const t = (title || "").trim();
  if (t.length < 6) return null;
  // `context` (a search snippet) only rescues a title that names no role at all, e.g. "Acme Jobs".
  if (!TITLE_POS.test(t) && !TITLE_POS.test(context)) return `title doesn't look like a target role ("${t.slice(0, 60)}")`;
  if (TITLE_HARD_NEG.test(t)) return `title is outside the target role families ("${t.slice(0, 60)}")`;
  if (TITLE_SOFT_NEG.test(t) && !TITLE_STRONG.test(t)) return `title is outside the target role families ("${t.slice(0, 60)}")`;
  return null;
}

/** Higher = more promising; used to spend the limited per-run screenings on the best candidates first. */
export function hintRank(title: string): number {
  const t = title || "";
  let r = 0;
  if (TITLE_STRONG.test(t)) r += 4;
  if (/cloud|devsecops|sre\b|reliability|devops|platform|infrastructure|kubernetes/i.test(t)) r += 2;
  if (/\b(senior|sr\.?|staff|lead|principal)\b/i.test(t)) r += 1;
  if (/italy|italia|europe|emea|\beu\b|worldwide|anywhere|remote/i.test(t)) r += 2;
  if (/united states|\busa?\b|u\.s\.|canada|india|philippines|latam|\bus\b/i.test(t)) r -= 3;
  // "junior" is deliberately not penalised: junior/mid DevOps roles are in scope.
  if (/\b(intern|graduate|trainee|director|vp|head of|chief)\b/i.test(t)) r -= 3;
  if (/\bmanager\b/i.test(t)) r -= 2;
  return r;
}

/**
 * Search results with no page age, or an old one, are mostly postings that have since closed (measured: ~1 in 8 of
 * age-less Lever/Ashby/Greenhouse/Workable results was still live, vs ~2 in 3 of those seen in the last 3 months).
 * Every dead link costs a request to discover, so fresher pages are verified first.
 */
export function freshnessRank(days: number | null): number {
  if (days == null) return -3;
  if (days <= 120) return 3;
  if (days <= 180) return -1;
  return -4;
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
