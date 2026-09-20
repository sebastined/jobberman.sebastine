# jobberman.sebastine — Project Notes

This file exists so work can resume from any device/session with full context. Read this first.

## What this project is

A semi-automated job-search pipeline for Sebastine Nnanemere (Senior Cloud Security Engineer, Sicily, Italy). It discovers new postings on a schedule, screens them against `candidate-profile.md`, tailors CV notes for the ones worth pursuing, and logs everything to a live tracker. It stops one step short of submitting applications — that step is manual by design (see "Known gaps" below).

**Local checkout:** `C:\work\sebastine.com\jobberman.sebastine`
No remote configured yet — local git repo only, matching the per-project convention used by sibling folders (`cv.sebastine`, `vigilsec.it`).

## How it works

1. **Discover** — free, no-key job-board APIs (Remotive, Arbeitnow, RemoteOK) plus WebSearch for broader coverage. Any posting hosted on Greenhouse, Lever, or Ashby gets its full text pulled from that ATS's public JSON API (`boards-api.greenhouse.io`, `api.lever.co/v0/postings/<company>`, `api.ashbyhq.com/posting-api/job-board/<company>`) rather than scraped HTML — much more reliable than fetching the rendered page, since those are client-side-rendered SPAs that return no content to a plain fetch.
2. **Screen & score** — against `candidate-profile.md`'s rubric. Dedupe against what's already in the tracker (by source URL) before adding anything.
3. **Tailor** — for `apply`/`review` tier postings, draft a 3–4 sentence tailored summary + which bullets from the master CV to lead with, referencing the CV template doc (see below). `skip` tier is not logged, to keep the tracker signal-only.
4. **Log** — new rows go into the tracker (see "Where the data lives").
5. **Stop for approval.** Nothing gets submitted automatically. The user reviews the tracker and applies by hand via the source URL.

## Where the data lives

- **Live tracker:** https://claude.ai/artifact/RxsbsAxcDHnnT7zH4MZtna — a private Artifact ("Jobberman Tracker") with the `db` capability, `postings` collection. Claude writes new rows to it directly on every scheduled run (via the `ArtifactData` tool); it's one stable link, always current. Doc id = a slug of company+title; dedupe by checking for that id (or querying `sourceUrl`) before adding.
- **Weekly Google Sheet export:** once a week, export the tracker's current state as a real spreadsheet into the user's Google Drive via `mcp__claude_ai_Google_Drive__create_file` (`textContent` as CSV, converts to a native Sheet automatically).
  **Why not just live in Drive:** the Google Drive MCP connector available to this session can *create* files but has no "update file content" call — `update_file` only changes title/parentId. A tracker that needs continuous updates can't live there directly without either changing its URL on every write (unacceptable) or growing a new duplicate file per update (worse). The Artifact's `db` capability is a real read/write store with one stable URL, so that's the source of truth; Drive gets a point-in-time CSV→Sheet snapshot instead. Re-check this if Anthropic ever ships a Sheets-values-style MCP tool — that would let the Sheet be the live source directly.
- **Master CV:** `C:\work\sebastine.com\cv.sebastine\Sebastine_Nnanemere_MASTER_CV.pdf` is the one true CV. This project doesn't fork it per-application; tailoring means picking which existing bullets to lead with and drafting a short cover note, not inventing new claims.

## The scheduled run

Routine ID `trig_01VcyBPCT3n8bbbqUtWA54Xm` ("Jobberman - weekday job search and screen"), created 2026-09-20 via the `/schedule` skill / `RemoteTrigger` API. Runs `0 6 * * 1-5` (6am UTC = 8am Europe/Rome on weekdays; will read as 7am local once CET/winter time resumes — cron is fixed UTC and doesn't auto-shift with DST, revisit if that drift matters). Attached MCP connector: Google-Drive (for the Friday export).

The routine's prompt is **fully self-contained** — it embeds the candidate profile, hard filters, scoring rubric, and condensed real experience directly, rather than reading `candidate-profile.md` off disk, because **this account's GitHub isn't connected to Claude Code cloud routines yet** (`sources: [{git_repository: ...}]` was tried first and rejected with `Connect your GitHub account before saving a routine that uses a GitHub repository`). The repo is pushed to `https://github.com/sebastined/jobberman.sebastine` regardless, for local reference and version history.

**If `candidate-profile.md` changes (new cert passed, salary floor changes, location changes, etc.), the routine's embedded prompt must be updated to match — editing this file alone does not update the live schedule.** Use `/schedule` (or `RemoteTrigger` with `action: update`, `trigger_id: trig_01VcyBPCT3n8bbbqUtWA54Xm`) to edit it.

**If GitHub gets connected later** (https://claude.ai/customize/connectors), the routine can be simplified: swap the embedded profile block for `sources: [{git_repository: {url: "https://github.com/sebastined/jobberman.sebastine"}}]` plus an instruction to read `candidate-profile.md` from the clone — then this file becomes the actual single source of truth instead of a copy that has to be kept in sync by hand.

## Known gaps (v1, deliberate)

1. **No auto-submit.** Filling and submitting actual ATS forms (Greenhouse/Lever/Ashby) would need a browser-automation tool (e.g. a Playwright MCP server) that isn't configured in this Claude Code setup, and this sandboxed session's network egress is DoH-plus-allowlist only — real browser automation needs full egress, so that piece likely needs to run somewhere else entirely (the user's own machine, or a cloud environment set up for it). Revisit once that tooling exists; the tracker already has an "Approved to Apply" style status column so wiring in auto-submit later just means reading that column instead of redesigning the schema.
2. **Drive can't be the live store** — see above. Weekly export is the compromise.
3. **Adzuna and similar keyed APIs are not wired in** — v1 only uses no-key sources (Remotive, Arbeitnow, RemoteOK) plus WebSearch. If posting volume/coverage turns out too thin, revisit adding Adzuna (needs a free `app_id`/`app_key` signup) or a similar keyed aggregator.
4. **Job-alert email parsing is not wired in** — would need Gmail MCP access, which isn't authorized yet in this environment.

## Known gotchas

- Windows PowerShell 5.1's `Get-Content -Raw` → `Set-Content` round-trip mangles non-ASCII characters (same issue documented in `cv.sebastine/CLAUDE.md`) — use Node or the Edit tool, not PowerShell text round-trips, for anything touching this repo's files.
- The master CV PDF has no separate source file (Word/Google Doc) — it's the compiled PDF itself. Any future edits to it need the same careful text-layer-patch approach used to fix the AWS Security Specialty line on 2026-09-20 (see `cv.sebastine/CLAUDE.md` for that fix's method), not a naive round-trip.
