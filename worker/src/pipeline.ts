import type { Env, RunEvent, Track } from "./types";
import { Budget, FatalApiError, sleep } from "./budget";
import { classifyJobUrl, type JobUrlInfo } from "./canon";
import { braveSearch, fetchPosting } from "./sources";
import { screenPosting } from "./claude";
import { judge, quickReject } from "./rules";
import { cleanupStaleRuns, finishRun, getKnownUrls, insertPosting, saveSeenBatch, startRun, type SeenRow } from "./db";

// ---- Discovery queries -----------------------------------------------------
// Rotated: each run takes a few from the list, so coverage builds across the
// day's runs instead of one run trying to do everything inside its budget.

const ROLES = [
  '"cloud security engineer"',
  '"devsecops engineer"',
  '"security engineer"',
  '("GRC" OR "security compliance" OR "compliance specialist")',
  '("IAM engineer" OR "identity and access management")',
  '"incident response"',
  '"site reliability engineer"',
  '"cloud engineer" AWS',
  '"security architect"',
  '"information security" (specialist OR officer OR analyst)',
];

const PLATFORMS = [
  "site:jobs.ashbyhq.com",
  "(site:jobs.lever.co OR site:jobs.eu.lever.co)",
  "(site:job-boards.greenhouse.io OR site:boards.greenhouse.io)",
  "site:jobs.smartrecruiters.com",
  "(site:jobs.personio.com OR site:teamtailor.com OR site:recruitee.com)",
];

const ITALY_QUERIES = ROLES.flatMap((role) => PLATFORMS.map((p) => `${p} ${role} (Italy OR Europe OR EMEA OR "EU") remote`));

const SPONSOR_ROLES = ['"cloud security engineer"', '"devsecops engineer"', '"security engineer"', '("GRC" OR "security compliance")', '("IAM engineer" OR "identity and access management")', '("site reliability engineer" OR "cloud engineer")'];
const SPONSOR_COUNTRIES = [
  '"United States" OR USA',
  "Canada",
  'Ireland OR "United Kingdom" OR Scotland OR Wales',
  "Germany OR France",
  'Poland OR Czechia OR "Czech Republic" OR Hungary',
  "Portugal OR Estonia OR Lithuania",
];
const SPONSORSHIP_QUERIES = SPONSOR_ROLES.flatMap((role) =>
  SPONSOR_COUNTRIES.map(
    (c) => `(site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:job-boards.greenhouse.io OR site:jobs.smartrecruiters.com) ${role} ("visa sponsorship" OR "we sponsor" OR relocation) (${c})`,
  ),
);

function pickQueries(list: string[], seed: number, n: number): string[] {
  const start = (Math.abs(seed) * n) % list.length;
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(start + i) % list.length]);
}

// ---- Run --------------------------------------------------------------------

export interface RunOptions {
  tracks?: Track[];
  onEvent?: (e: RunEvent) => void;
  /** Rotates which discovery queries this run uses. */
  seed?: number;
  /** Cap on Claude screenings per track per run (cost control). */
  maxScreens?: number;
}

export interface RunSummary {
  run_id: number;
  status: "ok" | "error";
  evaluated: number;
  added: number;
  budget_used: number;
  notes: string[];
}

// Workers Free allows 50 external subrequests per invocation; stay under it with headroom.
const TOTAL_BUDGET = 44;

export async function runPipeline(env: Env, opts: RunOptions = {}): Promise<RunSummary> {
  const tracks = opts.tracks ?? ["italy-remote", "sponsorship"];
  const emit = opts.onEvent ?? (() => {});
  await cleanupStaleRuns(env);
  const runId = await startRun(env);
  emit({ type: "start", run_id: runId, tracks });

  const notes: string[] = [];
  let evaluated = 0;
  let added = 0;
  let budgetUsed = 0;
  let status: "ok" | "error" = "ok";
  const perTrack = Math.floor(TOTAL_BUDGET / tracks.length);

  try {
    for (const track of tracks) {
      const budget = new Budget(perTrack);
      try {
        const r = await runTrack(env, track, budget, opts, emit, notes);
        evaluated += r.evaluated;
        added += r.added;
      } finally {
        budgetUsed += budget.used;
      }
    }
  } catch (err) {
    status = "error";
    const message = (err as Error).message;
    notes.push(`FATAL: ${message}`);
    emit({ type: "error", message, fatal: true });
  }

  try {
    await finishRun(env, runId, status, added, evaluated, notes.join(" | "));
  } catch (err) {
    console.error("finishRun failed:", (err as Error).message);
  }
  emit({ type: "done", run_id: runId, status, evaluated, added, budget_used: budgetUsed, notes });
  return { run_id: runId, status, evaluated, added, budget_used: budgetUsed, notes };
}

const RETRY_UNVERIFIED_AFTER_MS = 3 * 24 * 3600_000;

async function runTrack(
  env: Env,
  track: Track,
  budget: Budget,
  opts: RunOptions,
  emit: (e: RunEvent) => void,
  notes: string[],
): Promise<{ evaluated: number; added: number }> {
  const seed = opts.seed ?? Math.floor(Date.now() / (20 * 60_000));
  const queries = pickQueries(track === "italy-remote" ? ITALY_QUERIES : SPONSORSHIP_QUERIES, seed, 3);

  // 1. Discover: keep only real job-detail pages on known ATS platforms.
  const found = new Map<string, JobUrlInfo>();
  let totalHits = 0;
  for (const q of queries) {
    if (!budget.take()) break;
    const hits = await braveSearch(env.BRAVE_SEARCH_API_KEY, q, 10);
    totalHits += hits.length;
    emit({ type: "search", track, query: q.slice(0, 120), hits: hits.length });
    for (const h of hits) {
      const info = classifyJobUrl(h.url);
      if (info && !found.has(info.canonical)) found.set(info.canonical, info);
    }
    await sleep(1100); // Brave's free tier allows ~1 request/second
  }

  // 2. Drop what we've already judged or already track (one D1 round trip for all of it).
  const all = [...found.values()];
  const known = await getKnownUrls(env, all.map((i) => i.canonical), new Date(Date.now() - RETRY_UNVERIFIED_AFTER_MS).toISOString());
  const fresh = all.filter((i) => !known.has(i.canonical));
  emit({ type: "discovered", track, hits: totalHits, job_pages: all.length, fresh: fresh.length });

  // 3. Fetch live, pre-filter, screen.
  const pending: SeenRow[] = [];
  const now = () => new Date().toISOString();
  const seen = (info: JobUrlInfo, decision: string, score = 0) => pending.push({ id: info.canonical, date_evaluated: now(), decision, score, source_url: info.canonical });
  const maxScreens = opts.maxScreens ?? 10;
  const claude = { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL };

  let evaluated = 0;
  let added = 0;
  let screens = 0;
  let consecutiveErrors = 0;

  try {
    for (const info of fresh) {
      if (screens >= maxScreens) {
        notes.push(`${track}: screening cap (${maxScreens}) reached`);
        break;
      }
      if (budget.left < 2) {
        notes.push(`${track}: subrequest budget exhausted`);
        break;
      }

      budget.take();
      const fetched = await fetchPosting(info);
      if (!fetched) {
        seen(info, "unverified - could not fetch live source this run");
        emit({ type: "candidate", track, url: info.canonical, outcome: "unverified", detail: "couldn't fetch the live posting" });
        continue;
      }
      if (fetched.gone) {
        seen(info, "skip - posting no longer exists at its source (HTTP 404/410)");
        emit({ type: "candidate", track, url: info.canonical, outcome: "expired", detail: "posting no longer exists (404 at its ATS)" });
        continue;
      }
      if (fetched.expired) {
        seen(info, "skip - posting closed/expired per its own page");
        emit({ type: "candidate", track, url: info.canonical, outcome: "expired", detail: "posting is closed", title: fetched.title });
        continue;
      }
      const reject = quickReject(track, fetched.text);
      if (reject) {
        seen(info, `skip - prefilter: ${reject}`);
        emit({ type: "candidate", track, url: info.canonical, outcome: "skipped", detail: reject, title: fetched.title });
        continue;
      }

      screens++;
      budget.take();
      let screened;
      try {
        screened = await screenPosting(claude, track, info.canonical, fetched.text);
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof FatalApiError) throw err;
        consecutiveErrors++;
        const message = (err as Error).message;
        emit({ type: "candidate", track, url: info.canonical, outcome: "error", detail: message.slice(0, 200), title: fetched.title });
        if (consecutiveErrors >= 3) throw new Error(`Claude API failing repeatedly: ${message}`);
        continue;
      }

      const verdict = judge(track, screened, fetched.text);
      const r = verdict.result;
      evaluated++;
      seen(info, `${verdict.decision} (score ${r.score})${verdict.qualifies ? " - added" : ""}`, r.score);

      if (!verdict.qualifies) {
        emit({
          type: "candidate", track, url: info.canonical, outcome: "screened", company: r.company, title: r.title,
          score: r.score, decision: verdict.decision,
          detail: r.hard_filter_failures[0] ?? (track === "sponsorship" && !verdict.sponsorshipVerified ? "sponsorship not verified in the posting text" : r.one_line_reason),
        });
        continue;
      }

      await insertPosting(env, {
        id: postingId(r.company, r.title, info.canonical),
        company: r.company || info.company,
        title: r.title || fetched.title || "Untitled role",
        track,
        location: r.location,
        source_url: info.canonical,
        salary: r.salary,
        score: r.score,
        decision: verdict.decision,
        confidence: r.confidence,
        remote_eligibility: r.remote_eligibility,
        seniority_detected: r.seniority_detected,
        matched_requirements: r.matched_requirements,
        gaps: r.gaps,
        one_line_reason: r.one_line_reason,
        tailored_summary: r.tailoring_note,
        sponsorship_country: track === "sponsorship" ? r.sponsorship_country || null : null,
        sponsorship_verified: track === "sponsorship" && verdict.sponsorshipVerified,
        sponsorship_evidence: track === "sponsorship" && verdict.sponsorshipVerified ? r.sponsorship_evidence : null,
        date_found: now(),
      });
      added++;
      emit({ type: "candidate", track, url: info.canonical, outcome: "added", company: r.company, title: r.title, score: r.score, decision: verdict.decision, detail: r.one_line_reason });
    }
  } finally {
    await saveSeenBatch(env, pending).catch((e) => console.error("saveSeenBatch failed:", (e as Error).message));
  }

  notes.push(`${track}: ${totalHits} hits → ${all.length} job pages → ${fresh.length} new; screened ${evaluated}, added ${added}`);
  return { evaluated, added };
}

function postingId(company: string, title: string, canonical: string): string {
  const slug = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${slug}-${(h >>> 0).toString(36)}`;
}
