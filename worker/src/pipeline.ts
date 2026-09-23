import type { Env } from "./types";
import { braveSearch, fetchPostingText } from "./sources";
import { screenPosting } from "./claude";
import { hasSeen, markSeen, insertPosting, startRun, finishRun } from "./db";

// Query templates crossed with role keywords to discover candidate postings.
// Kept intentionally modest per run (Workers scheduled-handler execution time
// and Claude/Brave API cost both scale with this) — the cron fires 4x/day,
// so coverage builds up across runs rather than needing to be exhaustive once.
const ROLE_KEYWORDS = [
  "cloud security engineer",
  "DevSecOps engineer",
  "GRC OR compliance specialist",
  "IAM engineer",
  "site reliability engineer",
  "cloud engineer",
];

const ITALY_QUERIES = ROLE_KEYWORDS.flatMap((role) => [
  `${role} remote Italy`,
  `${role} remote Europe site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:job-boards.greenhouse.io`,
]);

const SPONSORSHIP_COUNTRIES = ["Germany", "Canada", "Ireland", "USA", "Poland", "Portugal"];
const SPONSORSHIP_QUERIES = SPONSORSHIP_COUNTRIES.map(
  (country) => `cloud security OR GRC OR DevSecOps engineer "visa sponsorship" ${country}`,
);

function slugify(company: string, title: string): string {
  return `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

interface RunSummary {
  evaluated: number;
  added: number;
  notes: string[];
}

export async function runPipeline(env: Env): Promise<RunSummary> {
  const runId = await startRun(env);
  const notes: string[] = [];
  let evaluated = 0;
  let added = 0;

  try {
    added += await runTrack(env, "italy-remote", ITALY_QUERIES, notes, (n) => (evaluated += n));
    added += await runTrack(env, "sponsorship", SPONSORSHIP_QUERIES, notes, (n) => (evaluated += n));
    await finishRun(env, runId, "ok", added, evaluated, notes.join(" | "));
  } catch (err) {
    notes.push(`FATAL: ${(err as Error).message}`);
    await finishRun(env, runId, "error", added, evaluated, notes.join(" | "));
    throw err;
  }

  return { evaluated, added, notes };
}

async function runTrack(
  env: Env,
  track: "italy-remote" | "sponsorship",
  queries: string[],
  notes: string[],
  countEvaluated: (n: number) => void,
): Promise<number> {
  let added = 0;
  const candidateUrls = new Set<string>();

  for (const q of queries) {
    const hits = await braveSearch(env.BRAVE_SEARCH_API_KEY, q, 6);
    for (const hit of hits) candidateUrls.add(hit.url);
  }

  let evaluatedThisTrack = 0;
  for (const url of candidateUrls) {
    // Cap work per run so a single cron fire stays well within execution limits.
    if (evaluatedThisTrack >= 20) break;

    const tentativeId = url.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 100);
    if (await hasSeen(env, tentativeId)) continue;

    const text = await fetchPostingText(url);
    if (!text) {
      await markSeen(env, tentativeId, "unverified - could not fetch live source this run", 0, url);
      continue;
    }

    evaluatedThisTrack++;
    let result;
    try {
      result = await screenPosting(env.ANTHROPIC_API_KEY, track, url, text);
    } catch (err) {
      notes.push(`screen failed for ${url}: ${(err as Error).message}`);
      continue;
    }

    const id = slugify(result.company || url, result.title || "role");
    await markSeen(env, id, `${result.decision} (score ${result.score})`, result.score, url);
    if (tentativeId !== id) await markSeen(env, tentativeId, `duplicate of ${id}`, result.score, url);

    const qualifies =
      track === "italy-remote"
        ? result.decision !== "skip" && result.score >= 55
        : result.decision !== "skip" && result.score >= 60 && result.sponsorship_verified;

    if (!qualifies) continue;

    await insertPosting(env, {
      id,
      company: result.company,
      title: result.title,
      track,
      location: result.location,
      source_url: url,
      salary: result.salary,
      score: result.score,
      decision: result.decision,
      confidence: result.confidence,
      remote_eligibility: result.remote_eligibility,
      seniority_detected: result.seniority_detected,
      matched_requirements: result.matched_requirements,
      gaps: result.gaps,
      one_line_reason: result.one_line_reason,
      sponsorship_country: track === "sponsorship" ? guessCountry(result.location) : undefined,
      sponsorship_verified: track === "sponsorship" ? result.sponsorship_verified : undefined,
      sponsorship_evidence: track === "sponsorship" ? result.sponsorship_evidence : undefined,
      date_found: new Date().toISOString(),
    });
    added++;
  }

  countEvaluated(evaluatedThisTrack);
  notes.push(`${track}: evaluated ${evaluatedThisTrack}, added ${added}`);
  return added;
}

function guessCountry(location: string): string | undefined {
  const countries = [
    "USA", "United States", "Canada", "Ireland", "France", "Estonia", "Lithuania",
    "Czechia", "Czech Republic", "Hungary", "Germany", "Portugal", "Poland",
    "UK", "United Kingdom", "Scotland", "Wales",
  ];
  return countries.find((c) => location?.includes(c));
}
