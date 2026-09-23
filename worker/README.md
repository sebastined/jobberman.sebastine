# Jobberman worker

Cloudflare Worker that replaces the old Claude Code scheduled routine + Artifact tracker.

- **Cron Triggers** run the discover → verify → screen pipeline (Berlin 8am/9am/9pm/10pm, Mon–Fri).
  `:00` screens the Italy-remote track, `:30` the sponsorship track.
- **D1** stores `postings` (the tracker), `seen` (every posting ever judged, for dedup) and `runs` (one row per fire).
- A **static UI** (`public/`) talks to a small authenticated JSON API. Board + list views, drag-and-drop status changes with
  undo, a command palette (`Ctrl K`), a posting drawer, run history and a live run console.

Why it exists: the old routine died on the Claude Code sandbox's egress blocks and session rate limits. This runs on
ordinary Cloudflare networking with its own API billing.

## How a run works

1. **Discover** – 3 rotating Brave Search queries per run. Only URLs that are real *job-detail pages on a known ATS*
   (Greenhouse, Lever, Ashby, SmartRecruiters, Personio, Teamtailor, Recruitee, Workable) survive; aggregators, listicles and
   company index pages are dropped (`src/canon.ts`).
2. **Dedup** – by canonical URL against `seen` and `postings` in one D1 query. The old Artifact `seen` history was migrated
   (`seed-seen.sql`), including the postings you confirmed expired.
3. **Verify live** – each posting is fetched from its own ATS (JSON API where one exists, else the page's JSON-LD). A 404/410
   is final ("gone"). Nothing is ever screened from a search snippet.
4. **Pre-filter** (free) – obvious US/Canada-only postings, and (sponsorship track) postings with no visa/relocation
   language, never reach Claude.
5. **Screen** – Claude scores the fetched text against the rubric in `src/profile.ts`.
6. **Guardrails in code** (`src/rules.ts`) – the decision is re-derived from score + hard filters; on the sponsorship track
   the quoted sponsorship sentence must appear **verbatim** in the fetched posting text or the posting is skipped.

Every `fetch()` is metered against a budget of 44 outbound requests per invocation (Cloudflare's Free plan allows 50);
a run stops cleanly with a note rather than crashing.

## Setup (already done for the deployed instance)

```sh
cd worker && npm install
npx wrangler d1 create jobberman                 # paste the id into wrangler.jsonc
npm run db:init                                   # schema
npm run db:seed                                   # postings migrated from the Artifact tracker
npx wrangler d1 execute jobberman --remote --file=./seed-seen.sql   # dedup history

# secrets (each prompts for the value)
npx wrangler secret put ANTHROPIC_API_KEY         # console.anthropic.com — needs prepaid credit
npx wrangler secret put BRAVE_SEARCH_API_KEY      # brave.com/search/api — free tier is plenty
npx wrangler secret put TRACKER_TOKEN             # the access key for the UI/API (long random string)
npm run deploy
```

Open the tracker at `https://<worker>.workers.dev/#key=<TRACKER_TOKEN>` once per device — the key is stored in that
browser's localStorage and stripped from the URL. Without a key the API answers 401 (and fails closed if
`TRACKER_TOKEN` is unset).

## Operating it

| Need | How |
|---|---|
| Run now | "Run now" in the UI (streams live), or `curl -N -X POST -H "Authorization: Bearer $TOKEN" $URL/api/run` |
| Why no new jobs? | The health strip / run history in the UI, or `select * from runs order by id desc limit 5` |
| Logs | `npx wrangler tail` |
| Change the rubric | Edit `../candidate-profile.md` (source of truth) **and** `src/profile.ts` (what the Worker sends to Claude) |
| Change coverage | `ROLES`, `PLATFORMS`, `SPONSOR_*` in `src/pipeline.ts`; `maxScreens` caps Claude spend per run |
| Rotate the access key | `wrangler secret put TRACKER_TOKEN`, then re-open the `#key=` link |

## Local development

```sh
cp .dev.vars.example .dev.vars        # real Brave key; use the mock for Claude (below)
npm run db:init:local
npx wrangler d1 execute jobberman --local --file=./seed.sql
npx wrangler d1 execute jobberman --local --file=./seed-seen.sql
node scripts/mock-anthropic.mjs 8799  # stand-in for Anthropic — no credits used
npm run dev                           # http://127.0.0.1:8787/#key=<TRACKER_TOKEN from .dev.vars>
```

Set `ANTHROPIC_BASE_URL=http://127.0.0.1:8799` and `ANTHROPIC_API_KEY=mock` in `.dev.vars` to route screening to the mock.

Once the Anthropic account has credit, validate the exact request the Worker sends (model id, tool schema, prompt caching) without running a screening:

```sh
ANTHROPIC_API_KEY=... npx esbuild scripts/validate-request.ts --bundle --platform=node --format=esm --outfile=.tmp/vr.mjs && node .tmp/vr.mjs   # expect HTTP 200 + an input_tokens count
```

Guardrail self-test (canonicalisation, pre-filters, sponsorship-quote check, decision logic):

```sh
npx esbuild scripts/selftest.ts --bundle --platform=node --format=esm --outfile=.tmp/selftest.mjs && node .tmp/selftest.mjs
```

## Limits worth knowing

- **Workers Free plan**: 50 outbound requests and 10 ms CPU per invocation. Runs are sized to fit; if a run is reported as
  "interrupted", Workers Paid ($5/mo) lifts both limits.
- **Cost**: each screening is one Claude call (~a cent or two). The pre-filters and `maxScreens` (default 10 per run) keep this small.
- **DST**: cron is fixed UTC, tuned for Berlin summer time; fires an hour earlier by the clock in winter.
- **Not ported**: tailored-CV generation/hosting (`../tailor-cv/generate.mjs` is still a manual, session-driven step) and phone
  push notifications — the health strip in the UI replaces them.
