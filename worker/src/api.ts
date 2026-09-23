import type { Env, Status } from "./types";
import { listPostings, updatePostingStatus, getPosting } from "./db";
import { APPLIED_STATUSES } from "./types";

const VALID_STATUSES: Status[] = [
  "Pending Review", "Approved to Apply", "Applied", "Interview", "Rejected", "Not Pursuing",
];

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/postings" && req.method === "GET") {
    const postings = await listPostings(env);
    return json(postings);
  }

  const statusMatch = path.match(/^\/api\/postings\/([^/]+)\/status$/);
  if (statusMatch && req.method === "PATCH") {
    const id = decodeURIComponent(statusMatch[1]);
    const body = (await req.json().catch(() => null)) as { status?: string } | null;
    if (!body?.status || !VALID_STATUSES.includes(body.status as Status)) {
      return json({ error: "invalid status" }, { status: 400 });
    }
    const posting = await getPosting(env, id);
    if (!posting) return json({ error: "not found" }, { status: 404 });
    await updatePostingStatus(env, id, body.status as Status);
    return json({ ok: true });
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
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [fields.join(",")];
    for (const p of postings) lines.push(fields.map((f) => esc((p as any)[f])).join(","));
    return new Response(lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="jobberman-applied-jobs.csv"',
      },
    });
  }

  return json({ error: "not found" }, { status: 404 });
}
