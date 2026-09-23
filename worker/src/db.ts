import type { Env, Posting, RunRow, Status, Track } from "./types";

function rowToPosting(row: any): Posting {
  return {
    ...row,
    matched_requirements: JSON.parse(row.matched_requirements || "[]"),
    gaps: JSON.parse(row.gaps || "[]"),
    sponsorship_verified: !!row.sponsorship_verified,
  };
}

export async function listPostings(env: Env): Promise<Posting[]> {
  const { results } = await env.DB.prepare("SELECT * FROM postings ORDER BY score DESC, date_found DESC LIMIT 500").all();
  return (results || []).map(rowToPosting);
}

export async function getPosting(env: Env, id: string): Promise<Posting | null> {
  const row = await env.DB.prepare("SELECT * FROM postings WHERE id = ?").bind(id).first();
  return row ? rowToPosting(row) : null;
}

export async function updatePostingStatus(env: Env, id: string, status: Status): Promise<boolean> {
  const res = await env.DB.prepare("UPDATE postings SET status = ?, status_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, new Date().toISOString(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface NewPosting {
  id: string;
  company: string;
  title: string;
  track: Track;
  location: string;
  source_url: string;
  salary: string;
  score: number;
  decision: "apply" | "review" | "skip";
  confidence: string;
  remote_eligibility: string;
  seniority_detected: string;
  matched_requirements: string[];
  gaps: string[];
  one_line_reason: string;
  tailored_summary: string;
  sponsorship_country: string | null;
  sponsorship_verified: boolean;
  sponsorship_evidence: string | null;
  date_found: string;
}

export async function insertPosting(env: Env, p: NewPosting): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO postings (
      id, company, title, track, location, source_url, salary, score, decision, confidence,
      remote_eligibility, seniority_detected, matched_requirements, gaps, one_line_reason,
      tailored_summary, sponsorship_country, sponsorship_verified, sponsorship_evidence,
      status, date_found
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      p.id, p.company, p.title, p.track, p.location, p.source_url, p.salary, p.score, p.decision, p.confidence,
      p.remote_eligibility, p.seniority_detected, JSON.stringify(p.matched_requirements), JSON.stringify(p.gaps), p.one_line_reason,
      p.tailored_summary, p.sponsorship_country, p.sponsorship_verified ? 1 : 0, p.sponsorship_evidence,
      "Pending Review", p.date_found,
    )
    .run();
}

export interface SeenRow {
  id: string;
  date_evaluated: string;
  decision: string;
  score: number;
  source_url: string;
}

/** Canonical URLs we must not evaluate again: anything judged before, plus anything already in the tracker. */
export async function getKnownUrls(env: Env, urls: string[], unverifiedRetryCutoffIso: string): Promise<Set<string>> {
  const known = new Set<string>();
  if (!urls.length) return known;
  const marks = urls.map(() => "?").join(",");
  const [seen, posted] = await env.DB.batch([
    // Fetch failures ("unverified…") are retried after a few days; every other verdict is final.
    env.DB.prepare(`SELECT source_url FROM seen WHERE source_url IN (${marks}) AND (decision NOT LIKE 'unverified%' OR date_evaluated >= ?)`).bind(...urls, unverifiedRetryCutoffIso),
    env.DB.prepare(`SELECT source_url FROM postings WHERE source_url IN (${marks})`).bind(...urls),
  ]);
  for (const r of [...(seen.results || []), ...(posted.results || [])] as { source_url: string }[]) known.add(r.source_url);
  return known;
}

export async function saveSeenBatch(env: Env, rows: SeenRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO seen (id, date_evaluated, decision, score, source_url) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET date_evaluated = excluded.date_evaluated, decision = excluded.decision, score = excluded.score, source_url = excluded.source_url`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.id, r.date_evaluated, r.decision, r.score, r.source_url)));
}

export async function seenCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM seen").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function startRun(env: Env): Promise<number> {
  const res = await env.DB.prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')").bind(new Date().toISOString()).run();
  return res.meta.last_row_id as number;
}

export async function finishRun(env: Env, runId: number, status: "ok" | "error", added: number, evaluated: number, notes: string): Promise<void> {
  await env.DB.prepare("UPDATE runs SET finished_at = ?, status = ?, postings_added = ?, postings_evaluated = ?, notes = ? WHERE id = ?")
    .bind(new Date().toISOString(), status, added, evaluated, notes, runId)
    .run();
}

/** A run whose invocation was killed (or whose client disconnected) never records a finish; close those out. */
export async function cleanupStaleRuns(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  await env.DB.prepare(
    "UPDATE runs SET status = 'error', finished_at = ?, notes = COALESCE(notes || ' | ', '') || 'interrupted — invocation ended before the run recorded a finish' WHERE status = 'running' AND started_at < ?",
  )
    .bind(new Date().toISOString(), cutoff)
    .run();
}

export async function runInProgress(env: Env): Promise<boolean> {
  await cleanupStaleRuns(env);
  const row = await env.DB.prepare("SELECT 1 AS x FROM runs WHERE status = 'running' LIMIT 1").first();
  return !!row;
}

export async function listRuns(env: Env, limit = 12): Promise<RunRow[]> {
  await cleanupStaleRuns(env);
  const { results } = await env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").bind(limit).all();
  return (results || []) as unknown as RunRow[];
}
