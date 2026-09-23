# Jobberman worker

Cloudflare Workers replacement for the old Claude Code scheduled routine +
Artifact tracker. A Cron Trigger fires the search/screen pipeline 4x/day
(Berlin 8am/9am/9pm/10pm, Mon-Fri, same schedule as before); a D1 database
holds postings; a static page served by the Worker reads/writes over a
normal fetch API instead of the old flaky Artifact `db` capability.

Fixes two problems the old setup couldn't: the Claude Code sandbox's
egress blocking (this Worker has ordinary outbound network access) and the
sandbox's session/rate-limit rejections (this runs on separate API billing,
not shared Claude Code session usage).

## One-time setup

You need three things I can't provision myself:

1. **Cloudflare auth** — either run `wrangler login` in an interactive
   terminal, or set `CLOUDFLARE_API_TOKEN` in this shell's environment
   (Workers + D1 edit permissions).
2. **`ANTHROPIC_API_KEY`** — a real Anthropic API key (console.anthropic.com),
   billed separately from Claude Code usage. This is what the Worker calls
   to screen each posting.
3. **`BRAVE_SEARCH_API_KEY`** — sign up at https://brave.com/search/api/
   (free tier: 2,000 queries/month, plenty for 4 runs/day). This replaces
   the WebSearch tool for discovery.

Once you have those:

```sh
cd worker
npm install

# Create the D1 database, then paste the printed database_id into
# wrangler.jsonc (replacing REPLACE_AFTER_D1_CREATE)
npx wrangler d1 create jobberman

# Create tables, then load the 12 postings migrated from the old tracker
npm run db:init
npm run db:seed

# Secrets (prompts for the value, stores it encrypted on Cloudflare)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put BRAVE_SEARCH_API_KEY

# Ship it
npm run deploy
```

Wrangler prints the live URL (`https://jobberman.<your-subdomain>.workers.dev`)
after deploy — that's the new tracker link, replacing the old
`claude.ai/artifact/...` one.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in real keys
npm run db:init:local
npm run dev
```

`wrangler dev` serves the tracker at `http://localhost:8787` against a local
D1 copy. Hit `http://localhost:8787/run` to fire the pipeline manually
instead of waiting for the cron.

## Operating notes

- **Manual run:** `GET /run` on the deployed Worker fires the pipeline
  immediately (same as the old `RemoteTrigger action=run`). It's unauthenticated
  — fine while only you know the workers.dev URL; add a shared-secret check
  before pointing a public domain at this.
- **Debugging a run:** `npx wrangler tail` streams live logs, or query the
  `runs` table (`npx wrangler d1 execute jobberman --remote --command "select * from runs order by id desc limit 5"`)
  for a per-fire summary (evaluated/added counts, notes) without digging
  through logs — this is what the old `RemoteTrigger get_run_log` did.
- **Rubric changes:** edit `candidate-profile.md` in the repo root (source of
  truth) *and* `src/profile.ts` (what the Worker actually sends to Claude) —
  unlike the old routine prompt, there's no auto-sync between the two; keep
  them in step by hand, same discipline as before.
- **Cron/DST:** Cloudflare Cron Triggers are fixed UTC, same as the old
  routine — the schedule is tuned for Berlin summer time (CEST); it'll fire
  an hour earlier by the clock during CET winter months. Same accepted
  drift as before, not new.
- **Search coverage:** the pipeline runs a fixed set of role-keyword ×
  platform queries per track, capped at ~20 candidates evaluated per track
  per run to stay within execution limits and API cost. Broaden
  `ROLE_KEYWORDS` / `SPONSORSHIP_COUNTRIES` in `src/pipeline.ts` if you want
  wider coverage at the cost of more Claude/Brave API spend.
- **Not yet ported:** tailored-CV generation/hosting (still a local,
  session-driven step via `tailor-cv/generate.mjs`) and phone push
  notifications (`PushNotification` was Claude-Code-specific; nothing
  replaces it here yet — check the tracker page instead of waiting for a
  ping, or ask to wire up email via Cloudflare Email Workers).
