import type { BoardStat, Env, Posting, RunEvent, RunRow, SourceKind, Status, Track } from "./types";
import { LINKEDIN_BOARD } from "./boards";
import { classifyJobUrl, type Ats } from "./canon";
import { CRAWLABLE } from "./crawl";

function rowToPosting(row: any): Posting {
  return {
    ...row,
    matched_requirements: JSON.parse(row.matched_requirements || "[]"),
    gaps: JSON.parse(row.gaps || "[]"),
    sponsorship_verified: !!row.sponsorship_verified,
  };
}

/** True when the tracker already holds this company + title (the same role reached via a different board). */
export async function postingExists(env: Env, company: string, title: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM postings WHERE lower(company) = lower(?) AND lower(title) = lower(?) LIMIT 1").bind(company.trim(), title.trim()).first();
  return !!row;
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
  source_board: string;
  source_kind: SourceKind;
  date_found: string;
}

export async function insertPosting(env: Env, p: NewPosting): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO postings (
      id, company, title, track, location, source_url, salary, score, decision, confidence,
      remote_eligibility, seniority_detected, matched_requirements, gaps, one_line_reason,
      tailored_summary, sponsorship_country, sponsorship_verified, sponsorship_evidence,
      source_board, source_kind, status, date_found
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      p.id, p.company, p.title, p.track, p.location, p.source_url, p.salary, p.score, p.decision, p.confidence,
      p.remote_eligibility, p.seniority_detected, JSON.stringify(p.matched_requirements), JSON.stringify(p.gaps), p.one_line_reason,
      p.tailored_summary, p.sponsorship_country, p.sponsorship_verified ? 1 : 0, p.sponsorship_evidence,
      p.source_board, p.source_kind, "Pending Review", p.date_found,
    )
    .run();
}

export interface SeenRow {
  id: string;
  date_evaluated: string;
  decision: string;
  score: number;
  source_url: string;
  board: string;
}

// D1 allows at most 100 bound parameters per statement.
const CHUNK = 80;

/** Canonical URLs we must not evaluate again: anything judged before, plus anything already in the tracker. */
export async function getKnownUrls(env: Env, urls: string[], unverifiedRetryCutoffIso: string): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < urls.length; i += CHUNK) {
    const part = urls.slice(i, i + CHUNK);
    const marks = part.map(() => "?").join(",");
    const [seen, posted] = await env.DB.batch([
      // Fetch failures ("unverified…") are retried after a few days; every other verdict is final.
      env.DB.prepare(`SELECT source_url FROM seen WHERE source_url IN (${marks}) AND (decision NOT LIKE 'unverified%' OR date_evaluated >= ?)`).bind(...part, unverifiedRetryCutoffIso),
      env.DB.prepare(`SELECT source_url FROM postings WHERE source_url IN (${marks})`).bind(...part),
    ]);
    for (const r of [...(seen.results || []), ...(posted.results || [])] as { source_url: string }[]) known.add(r.source_url);
  }
  return known;
}

export async function saveSeenBatch(env: Env, rows: SeenRow[]): Promise<void> {
  if (!rows.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO seen (id, date_evaluated, decision, score, source_url, board) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET date_evaluated = excluded.date_evaluated, decision = excluded.decision, score = excluded.score, source_url = excluded.source_url, board = excluded.board`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.id, r.date_evaluated, r.decision, r.score, r.source_url, r.board)));
}

/** What each board has produced so far: how much was checked, how much of it was dead/filtered, and what was kept. */
export async function boardStats(env: Env): Promise<BoardStat[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.board AS board,
            COUNT(*) AS checked,
            SUM(CASE WHEN s.decision LIKE 'skip - posting%' THEN 1 ELSE 0 END) AS dead,
            SUM(CASE WHEN s.decision LIKE 'unverified%' THEN 1 ELSE 0 END) AS unverified,
            SUM(CASE WHEN s.decision LIKE 'skip - prefilter%' OR s.decision LIKE 'skip - duplicate%' THEN 1 ELSE 0 END) AS prefiltered,
            SUM(CASE WHEN s.decision LIKE '%(score %' THEN 1 ELSE 0 END) AS screened,
            SUM(CASE WHEN s.decision LIKE '%- added' THEN 1 ELSE 0 END) AS added,
            MAX(s.date_evaluated) AS last_seen
       FROM seen s
      WHERE s.board IS NOT NULL
      GROUP BY s.board`,
  ).all();
  return (results || []) as unknown as BoardStat[];
}

/** Postings in the tracker per board, including ones found before boards were tracked (backfilled from the URL). */
export async function trackerCountsByBoard(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("SELECT source_board AS board, COUNT(*) AS n FROM postings WHERE source_board IS NOT NULL GROUP BY source_board").all();
  const out: Record<string, number> = {};
  for (const r of (results || []) as unknown as { board: string; n: number }[]) out[r.board] = r.n;
  // Roles reached through a LinkedIn lead are filed under their employer's job system; count them here too.
  const li = await env.DB.prepare("SELECT COUNT(*) AS n FROM postings WHERE source_kind = 'linkedin'").first<{ n: number }>();
  out[LINKEDIN_BOARD] = li?.n ?? 0;
  return out;
}

export async function seenCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM seen").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function startRun(env: Env): Promise<number> {
  const res = await env.DB.prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')").bind(new Date().toISOString()).run();
  return res.meta.last_row_id as number;
}

export async function finishRun(env: Env, runId: number, status: "ok" | "error", added: number, evaluated: number, notes: string, log: RunEvent[] = []): Promise<void> {
  await env.DB.prepare("UPDATE runs SET finished_at = ?, status = ?, postings_added = ?, postings_evaluated = ?, notes = ?, log = ? WHERE id = ?")
    .bind(new Date().toISOString(), status, added, evaluated, notes, JSON.stringify(log), runId)
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
  const { results } = await env.DB.prepare("SELECT id, started_at, finished_at, status, postings_added, postings_evaluated, notes FROM runs ORDER BY id DESC LIMIT ?").bind(limit).all();
  return (results || []) as unknown as RunRow[];
}

// ---- company job boards (crawl queue) ------------------------------------------------------------

export interface CompanyRow {
  key: string;
  ats: Ats;
  slug: string;
  eu: number;
  last_crawled: string | null;
  added: number;
}

export const companyKey = (ats: string, slug: string) => `${ats}:${slug.toLowerCase()}`;

/** Remember companies seen on crawlable job systems; ones already known are left as they are. */
export async function upsertCompanies(env: Env, rows: { ats: Ats; slug: string; eu?: boolean; sponsors?: boolean }[]): Promise<void> {
  const byKey = new Map<string, { ats: Ats; slug: string; eu: boolean; hits: number; sponsors: boolean }>();
  for (const r of rows) {
    if (!CRAWLABLE.includes(r.ats) || !r.slug) continue;
    const key = companyKey(r.ats, r.slug);
    const cur = byKey.get(key);
    if (cur) {
      cur.hits++;
      cur.sponsors ||= !!r.sponsors;
    } else byKey.set(key, { ats: r.ats, slug: r.slug, eu: !!r.eu, hits: 1, sponsors: !!r.sponsors });
  }
  if (!byKey.size) return;
  const stmt = env.DB.prepare(
    "INSERT INTO companies (key, ats, slug, eu, first_seen, hits, sponsors) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET hits = hits + excluded.hits, sponsors = MAX(sponsors, excluded.sponsors)",
  );
  const now = new Date().toISOString();
  await env.DB.batch([...byKey.entries()].map(([key, c]) => stmt.bind(key, c.ats, c.slug, c.eu ? 1 : 0, now, c.hits, c.sponsors ? 1 : 0)));
}

/** First run after the crawler shipped: learn the companies behind every job URL already evaluated. */
export async function seedCompaniesIfEmpty(env: Env): Promise<number> {
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM companies").first<{ n: number }>();
  if ((have?.n ?? 0) > 0) return 0;
  const { results } = await env.DB.prepare("SELECT source_url, 0 AS sp FROM seen WHERE source_url LIKE 'http%' UNION ALL SELECT source_url, CASE WHEN track = 'sponsorship' THEN 1 ELSE 0 END AS sp FROM postings WHERE source_url LIKE 'http%'").all();
  const rows: { ats: Ats; slug: string; eu?: boolean; sponsors?: boolean }[] = [];
  for (const r of (results || []) as unknown as { source_url: string; sp: number }[]) {
    const info = classifyJobUrl(r.source_url);
    if (info) rows.push({ ats: info.ats, slug: info.company, eu: info.eu, sponsors: r.sp === 1 });
  }
  await upsertCompanies(env, rows);
  return rows.length;
}

/**
 * Next companies to crawl: brand-new ones first (most-mentioned in search results first), then companies that have already produced a tracker entry (rechecked
 * daily, since they demonstrably hire for this profile), then whoever was crawled longest ago.
 */
export async function pickCompaniesToCrawl(env: Env, n: number, track: Track): Promise<CompanyRow[]> {
  if (n <= 0) return [];
  const now = Date.now();
  const marks = CRAWLABLE.map(() => "?").join(",");
  // Sponsorship: only companies known to mention sponsorship, plus job systems whose list already carries the full
  // text (Lever, Recruitee, Personio), where checking every role for sponsorship wording costs nothing.
  const sponsorClause = track === "sponsorship" ? "AND (sponsors = 1 OR ats IN ('lever','recruitee','personio'))" : "";
  const { results } = await env.DB.prepare(
    `SELECT key, ats, slug, eu, last_crawled, added FROM companies
      WHERE fail_count < 3 AND ats IN (${marks}) ${sponsorClause} AND (last_crawled IS NULL OR last_crawled < ?)
      ORDER BY CASE WHEN last_crawled IS NULL THEN 0 WHEN added > 0 AND last_crawled < ? THEN 1 ELSE 2 END,
               CASE WHEN last_crawled IS NULL THEN -hits ELSE 0 END, last_crawled ASC
      LIMIT ?`,
  )
    .bind(...CRAWLABLE, new Date(now - 6 * 3600_000).toISOString(), new Date(now - 24 * 3600_000).toISOString(), n)
    .all();
  return (results || []) as unknown as CompanyRow[];
}

export async function markCrawled(env: Env, updates: { key: string; status: "ok" | "gone" | "fail"; openRoles: number }[]): Promise<void> {
  if (!updates.length) return;
  const stmt = env.DB.prepare(
    "UPDATE companies SET last_crawled = ?, open_roles = ?, fail_count = CASE ? WHEN 'ok' THEN 0 WHEN 'gone' THEN 3 ELSE fail_count + 1 END WHERE key = ?",
  );
  const now = new Date().toISOString();
  await env.DB.batch(updates.map((u) => stmt.bind(now, u.openRoles, u.status, u.key)));
}

export async function markCompanySponsors(env: Env, ats: Ats, slug: string): Promise<void> {
  await env.DB.prepare("UPDATE companies SET sponsors = 1 WHERE key = ?").bind(companyKey(ats, slug)).run();
}

export async function bumpCompanyAdded(env: Env, ats: Ats, slug: string): Promise<void> {
  await env.DB.prepare("UPDATE companies SET added = added + 1 WHERE key = ?").bind(companyKey(ats, slug)).run();
}

export async function companyCounts(env: Env): Promise<{ known: number; crawled: number; with_postings: number }> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS known, SUM(CASE WHEN last_crawled IS NOT NULL THEN 1 ELSE 0 END) AS crawled, SUM(CASE WHEN added > 0 THEN 1 ELSE 0 END) AS with_postings FROM companies").first<{ known: number; crawled: number | null; with_postings: number | null }>();
  return { known: row?.known ?? 0, crawled: row?.crawled ?? 0, with_postings: row?.with_postings ?? 0 };
}

export async function getRun(env: Env, id: number): Promise<(RunRow & { log: RunEvent[] }) | null> {
  const row = (await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first()) as any;
  if (!row) return null;
  let log: RunEvent[] = [];
  try {
    log = JSON.parse(row.log || "[]");
  } catch {}
  return { ...row, log };
}
