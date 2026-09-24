# Jobberman worker

Cloudflare Worker that replaces the old Claude Code scheduled routine + Artifact tracker.

- **Cron Triggers** run the discover → crawl → verify → screen pipeline (Berlin 8am/9am/9pm/10pm, Mon–Fri).
  `:00` screens the Italy-remote track, `:30` the sponsorship track.
- **D1** stores `postings` (the tracker), `seen` (every posting ever judged, for dedup), `runs` (one row per fire, with its event log) and `companies` (job boards to crawl).
- A **static UI** (`public/`) talks to a small authenticated JSON API. Board + list views, drag-and-drop status changes with
  undo, a command palette (`Ctrl K`), a posting drawer, run history and a live run console.

Why it exists: the old routine died on the Claude Code sandbox's egress blocks and session rate limits. This runs on
ordinary Cloudflare networking with its own API billing.

Deployed to the Cloudflare account **"Mr Sebastine"** (where the `sebastine.com` zone lives) as the custom domain
`jobberman.sebastine.com` (`routes` in `wrangler.jsonc`; `account_id` is pinned there because the API token can see two accounts).
`public/_headers` marks responses `no-transform` so the zone doesn't inject its bot-detection inline script, which the strict CSP would block.

## Where postings come from (none of it needs a sign-in)

| Source | What it is | How it's verified |
|---|---|---|
| **14 employer job systems** — Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday, Personio, Teamtailor, Recruitee, Breezy HR, JazzHR, Join.com, Jobvite, Rippling | Job-detail pages found with Brave Search (`site:` queries) | Fetched live from the employer's own job API/page. 404/410 or a closed notice is final. |
| **Company job boards (crawl)** — Greenhouse, Ashby, SmartRecruiters, Workable, Breezy, Lever, Recruitee, Personio | The public job *list* of every company the pipeline has learned about (`companies` table) | One request returns every role open right now, with location + remote flag, so dead links and out-of-region roles are dropped for free. Also settles the search hits of a crawled company (absent from its list = closed). |
| **9 public job boards** — RemoteOK, Remotive, Jobicy, Himalayas, We Work Remotely, Working Nomads, The Muse, Jobspresso, Hacker News "Who is hiring" | Public feeds/APIs (Italy-remote track only) | Listing fetched live from the board, labelled "board listing" in the UI — not the employer's own page. |
| **LinkedIn (leads only)** | Roles LinkedIn lists publicly, read from *search-engine results* (title/snippet). LinkedIn itself is never fetched. | Each lead is looked up on the employer's own job system and only counted once verified there ("via LinkedIn" badge). |

Boards that require a sign-in are deliberately not used (no credentials, and ToS). Arbeitnow (2 MB JSON) is skipped for CPU reasons.

## How a run works

1. **Discover** – rotating Brave queries (4–5 per run, spread across role × job system × region so slices don't repeat), 2–3 public
   feeds, 1 LinkedIn query + up to 3 employer lookups. Only job-detail URLs on known job systems survive (`src/canon.ts`).
   Query shape matters: one quoted phrase plus a plain word returns ~20 job pages; OR-stacks return 0–4.
2. **Crawl** – up to 10 (Italy) / 8 (sponsorship) company boards per run, brand-new and most-mentioned first, proven ones
   (`added > 0`) rechecked daily (`src/crawl.ts`). Role-family and location checks run on the list, before any fetch. Same role
   posted for several locations is screened once; siblings share the verdict.
3. **Dedup** – by canonical URL against `seen` and `postings` (chunked D1 lookups); crawled company lists settle their own search hits.
4. **Rank** – title relevance, region words, page freshness (Brave `page_age`: age-less/old results are mostly closed), and a
   penalty for boards whose pages have mostly been dead. Workday tenants that block the public API are skipped for the run.
5. **Verify live** – each remaining posting is fetched from its own job system (or already came from a live list/feed).
   Nothing is ever screened from a search snippet.
6. **Pre-filter** (free) – US/Canada-only postings, on-site roles with no "remote" anywhere, and (sponsorship track) postings with no
   visa/relocation language never reach Claude.
7. **Screen** – Claude scores the fetched text against the rubric in `src/profile.ts` (`maxScreens` per run, default 14).
8. **Guardrails in code** (`src/rules.ts`) – the decision is re-derived from score + hard filters; on the sponsorship track
   the quoted sponsorship sentence must appear **verbatim** in the fetched posting text or the posting is skipped.

Every `fetch()` is metered against a budget of 44 outbound requests per invocation (Cloudflare's Free plan allows 50);
a run stops cleanly with a note rather than crashing. Each posting records where it came from (`source_board`, `source_kind`),
each run persists its event log (click a run in the UI), and the UI's **Boards & yield** tab shows what every source has produced.

## Setup (already done for the deployed instance)

```sh
cd worker && npm install
npx wrangler d1 create jobberman                 # paste the id into wrangler.jsonc
npm run db:init                                   # schema (existing databases: apply migrations/*.sql in order instead)
npm run db:seed                                   # postings migrated from the Artifact tracker
npx wrangler d1 execute jobberman --remote --file=./seed-seen.sql   # dedup history

# secrets (each prompts for the value)
npx wrangler secret put ANTHROPIC_API_KEY         # console.anthropic.com — needs prepaid credit
npx wrangler secret put BRAVE_SEARCH_API_KEY      # brave.com/search/api — free tier is plenty
npx wrangler secret put TRACKER_TOKEN             # the access key for the UI/API (long random string)
npm run deploy
```

Open the tracker at `https://jobberman.sebastine.com/#key=<TRACKER_TOKEN>` once per device — the key is stored in that
browser's localStorage and stripped from the URL. Without a key the API answers 401 (and fails closed if
`TRACKER_TOKEN` is unset).

## Operating it

| Need | How |
|---|---|
| Run now | "Run now" in the UI (streams live), or `curl -N -X POST -H "Authorization: Bearer $TOKEN" $URL/api/run` |
| Why no new jobs? | The health strip / run history in the UI, or `select * from runs order by id desc limit 5` |
| Logs | `npx wrangler tail` |
| Change the rubric | Edit `../candidate-profile.md` (source of truth) **and** `src/profile.ts` (what the Worker sends to Claude) |
| Change coverage | `ROLE_TERMS`, `PLATFORMS`, `SPONSOR_*` in `src/pipeline.ts`; feeds in `src/feeds.ts`; crawlers in `src/crawl.ts`; `maxScreens` caps Claude spend per run |
| Grow the crawl pool | `scripts/discover-boards.ts` probes company names against the supported job systems and writes a SQL seed for `companies` (that's how `migrations/0004_seed_companies.sql` was made). Companies found in search results are added automatically. |
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

Guardrail self-test (URL canonicalisation, pre-filters, sponsorship-quote check, decision logic, LinkedIn lead parsing, crawl eligibility, query rotation):

```sh
npx esbuild scripts/selftest.ts --bundle --platform=node --format=esm --outfile=.tmp/selftest.mjs && node .tmp/selftest.mjs
```

## Limits worth knowing

- **Workers Free plan**: 50 outbound requests per invocation (the binding limit; runs are sized to fit). Measured CPU is ~85–90 ms per
  run and runs complete, but if one is ever reported as "interrupted", Workers Paid ($5/mo) lifts both limits.
- **Cost**: each screening is one Claude call (~a cent or two). The pre-filters and `maxScreens` (default 14 per run) keep this small.
- **DST**: cron is fixed UTC, tuned for Berlin summer time; fires an hour earlier by the clock in winter.
- **Not ported**: tailored-CV generation/hosting (`../tailor-cv/generate.mjs` is still a manual, session-driven step) and phone
  push notifications — the health strip in the UI replaces them.
