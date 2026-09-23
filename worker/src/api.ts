import type { Env, RunEvent, Status, Track } from "./types";
import { APPLIED_STATUSES, STATUSES } from "./types";
import { getPosting, listPostings, listRuns, runInProgress, seenCount, updatePostingStatus } from "./db";
import { runPipeline } from "./pipeline";

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(init?.headers || {}) },
  });

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/ping" && req.method === "GET") return json({ ok: true });

  if (path === "/api/postings" && req.method === "GET") return json(await listPostings(env));

  const statusMatch = path.match(/^\/api\/postings\/([^/]+)\/status$/);
  if (statusMatch && req.method === "PATCH") {
    const id = decodeURIComponent(statusMatch[1]);
    const body = (await req.json().catch(() => null)) as { status?: string } | null;
    if (!body?.status || !STATUSES.includes(body.status as Status)) return json({ error: "invalid status" }, { status: 400 });
    if (!(await getPosting(env, id))) return json({ error: "not found" }, { status: 404 });
    await updatePostingStatus(env, id, body.status as Status);
    return json({ ok: true });
  }

  if (path === "/api/runs" && req.method === "GET") {
    const [runs, seen] = await Promise.all([listRuns(env, 12), seenCount(env)]);
    return json({ runs, seen_count: seen, server_time: new Date().toISOString() });
  }

  // Manual run: streams progress as NDJSON so the UI can show it live.
  if (path === "/api/run" && req.method === "POST") {
    if (await runInProgress(env)) return json({ error: "A run is already in progress" }, { status: 409 });
    const body = (await req.json().catch(() => ({}))) as { track?: string };
    const tracks: Track[] = body.track === "italy-remote" || body.track === "sponsorship" ? [body.track] : ["italy-remote", "sponsorship"];

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const emit = (e: RunEvent) => void writer.write(enc.encode(JSON.stringify(e) + "\n")).catch(() => {});

    const job = runPipeline(env, { tracks, onEvent: emit, seed: Math.floor(Math.random() * 1000) })
      .catch((err) => emit({ type: "error", message: (err as Error).message, fatal: true }))
      .finally(() => writer.close().catch(() => {}));
    ctx.waitUntil(job);

    return new Response(readable, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }

  if (path === "/api/export/applied.csv" && req.method === "GET") {
    const postings = (await listPostings(env)).filter((p) => APPLIED_STATUSES.includes(p.status));
    const fields = [
      "company", "title", "track", "sponsorship_verified", "sponsorship_evidence", "sponsorship_country",
      "location", "source_url", "salary", "score", "decision", "confidence", "remote_eligibility",
      "seniority_detected", "matched_requirements", "gaps", "one_line_reason", "tailored_summary",
      "status", "status_changed_at", "date_found", "tailored_cv_filename",
    ] as const;
    const esc = (v: unknown) => {
      if (v == null) return "";
      const s = Array.isArray(v) ? v.join("; ") : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [fields.join(",")];
    for (const p of postings) lines.push(fields.map((f) => esc((p as any)[f])).join(","));
    return new Response(lines.join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="jobberman-applied-jobs.csv"', "cache-control": "no-store" },
    });
  }

  return json({ error: "not found" }, { status: 404 });
}
