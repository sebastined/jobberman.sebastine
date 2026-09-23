import type { Env, Posting, Status, Track } from "./types";

function rowToPosting(row: any): Posting {
  return {
    ...row,
    matched_requirements: JSON.parse(row.matched_requirements || "[]"),
    gaps: JSON.parse(row.gaps || "[]"),
    sponsorship_verified: !!row.sponsorship_verified,
  };
}

export async function listPostings(env: Env): Promise<Posting[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM postings ORDER BY score DESC, date_found DESC LIMIT 500",
  ).all();
  return (results || []).map(rowToPosting);
}

export async function getPosting(env: Env, id: string): Promise<Posting | null> {
  const row = await env.DB.prepare("SELECT * FROM postings WHERE id = ?").bind(id).first();
  return row ? rowToPosting(row) : null;
}

export async function updatePostingStatus(env: Env, id: string, status: Status): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE postings SET status = ?, status_changed_at = ?, updated_at = datetime('now') WHERE id = ?",
  )
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
  tailored_summary?: string;
  sponsorship_country?: string;
  sponsorship_verified?: boolean;
  sponsorship_evidence?: string;
  date_found: string;
}

export async function insertPosting(env: Env, p: NewPosting): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO postings (
      id, company, title, track, location, source_url, salary, score, decision, confidence,
      remote_eligibility, seniority_detected, matched_requirements, gaps, one_line_reason,
      tailored_summary, sponsorship_country, sponsorship_verified, sponsorship_evidence,
      status, date_found
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      score = excluded.score, decision = excluded.decision, updated_at = datetime('now')`,
  )
    .bind(
      p.id, p.company, p.title, p.track, p.location, p.source_url, p.salary, p.score, p.decision,
      p.confidence, p.remote_eligibility, p.seniority_detected,
      JSON.stringify(p.matched_requirements), JSON.stringify(p.gaps), p.one_line_reason,
      p.tailored_summary ?? null, p.sponsorship_country ?? null,
      p.sponsorship_verified ? 1 : 0, p.sponsorship_evidence ?? null,
      "Pending Review", p.date_found,
    )
    .run();
}

export async function hasSeen(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM seen WHERE id = ?").bind(id).first();
  return !!row;
}

export async function markSeen(
  env: Env,
  id: string,
  decision: string,
  score: number,
  sourceUrl: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO seen (id, date_evaluated, decision, score, source_url) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET date_evaluated = excluded.date_evaluated, decision = excluded.decision, score = excluded.score`,
  )
    .bind(id, new Date().toISOString(), decision, score, sourceUrl)
    .run();
}

export async function startRun(env: Env): Promise<number> {
  const res = await env.DB.prepare("INSERT INTO runs (started_at, status) VALUES (?, 'running')")
    .bind(new Date().toISOString())
    .run();
  return res.meta.last_row_id as number;
}

export async function finishRun(
  env: Env,
  runId: number,
  status: "ok" | "error",
  postingsAdded: number,
  postingsEvaluated: number,
  notes: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE runs SET finished_at = ?, status = ?, postings_added = ?, postings_evaluated = ?, notes = ? WHERE id = ?",
  )
    .bind(new Date().toISOString(), status, postingsAdded, postingsEvaluated, notes, runId)
    .run();
}
