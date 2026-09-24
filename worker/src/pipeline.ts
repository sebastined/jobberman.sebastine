import type { Env, RunEvent, SourceKind, Track } from "./types";
import { Budget, FatalApiError, sleep } from "./budget";
import { BOARD_NAMES, canonicalUrl, classifyJobUrl, type Ats, type JobUrlInfo } from "./canon";
import { CRAWLABLE, crawlBoard, inScope, type BoardJob } from "./crawl";
import { braveSearch, fetchPosting, type Fetched } from "./sources";
import { pickFeeds, type FeedItem } from "./feeds";
import { companyMatches, isResolvable, parseLinkedInTitle, roleMatches, searchableRole, type Lead } from "./leads";
import { screenPosting } from "./claude";
import { freshnessRank, hintRank, judge, quickReject, titleTriage } from "./rules";
import { LINKEDIN_BOARD } from "./boards";
import { boardStats, bumpCompanyAdded, companyKey, cleanupStaleRuns, finishRun, getKnownUrls, insertPosting, markCompanySponsors, markCrawled, pickCompaniesToCrawl, postingExists, saveSeenBatch, seedCompaniesIfEmpty, startRun, upsertCompanies, type CompanyRow, type SeenRow } from "./db";

// ---- Discovery queries -----------------------------------------------------
// Rotated: each run takes a handful from the list, so coverage builds across the
// week's runs instead of one run trying to do everything inside its request budget.
//
// Shape matters. Probing Brave showed that a query with one quoted phrase plus a plain word or two returns ~20
// real job pages, while stacks of OR-groups and quoted alternatives return 0-4. Keep every query simple.

const ROLE_TERMS = [
  '"cloud security engineer"',
  '"devsecops engineer"',
  '"security engineer"',
  '"IAM engineer"',
  '"identity and access management"',
  "GRC",
  '"security compliance"',
  '"incident response"',
  '"site reliability engineer"',
  '"cloud engineer"',
  '"devops engineer"',
  '"platform engineer"',
  '"systems administrator"',
  '"network engineer"',
  '"network security engineer"',
  "fortinet",
  '"security architect"',
  '"information security"',
  '"cloud architect"',
  '"infrastructure engineer"',
  '"security analyst"',
  '"vulnerability management"',
];

// Every job system below serves postings to anyone, with no sign-in. One entry per search "site:" group.
const PLATFORMS = [
  "site:jobs.ashbyhq.com",
  "(site:jobs.lever.co OR site:jobs.eu.lever.co)",
  "(site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:job-boards.eu.greenhouse.io)",
  "site:jobs.smartrecruiters.com",
  "site:apply.workable.com",
  "site:myworkdayjobs.com",
  "(site:jobs.personio.com OR site:jobs.personio.de)",
  "site:teamtailor.com",
  "site:recruitee.com",
  "site:breezy.hr",
  "site:applytojob.com",
  "site:join.com/companies",
  "site:jobs.jobvite.com",
  "site:ats.rippling.com",
];

const ITALY_REGIONS = ["Europe remote", "Italy", "EMEA remote"];
const ITALY_QUERIES = ROLE_TERMS.flatMap((role) => PLATFORMS.flatMap((p) => ITALY_REGIONS.map((g) => `${p} ${role} ${g}`)));

const SPONSOR_ROLES = [
  '"cloud security engineer"',
  '"devsecops engineer"',
  '"security engineer"',
  '"IAM engineer"',
  "GRC",
  '"security compliance"',
  '"site reliability engineer"',
  '"cloud engineer"',
  '"devops engineer"',
  '"security architect"',
];
// "" = no country word; the rest are the target countries (Scotland/Wales fall under the United Kingdom).
const SPONSOR_COUNTRIES = ["", '"United States"', "Canada", "Ireland", '"United Kingdom"', "Germany", "France", "Poland", "Portugal", "Estonia", "Lithuania", "Czechia", "Hungary"];
const SPONSOR_PLATFORMS = [
  "(site:jobs.lever.co OR site:jobs.eu.lever.co)",
  "(site:job-boards.greenhouse.io OR site:boards.greenhouse.io)",
  "site:jobs.ashbyhq.com",
  "(site:jobs.smartrecruiters.com OR site:apply.workable.com)",
  "site:myworkdayjobs.com",
  "(site:jobs.personio.com OR site:recruitee.com OR site:teamtailor.com OR site:join.com/companies OR site:breezy.hr OR site:jobs.jobvite.com OR site:ats.rippling.com)",
];
const SPONSORSHIP_QUERIES = SPONSOR_ROLES.flatMap((role) =>
  SPONSOR_PLATFORMS.flatMap((p) => SPONSOR_COUNTRIES.map((c) => `${p} ${role} visa sponsorship${c ? " " + c : ""}`)),
);

// LinkedIn is only ever read as a *search-engine result* (title/snippet): a lead names a role and a company,
// which is then looked up on the employer's own job system. We never request a LinkedIn page.
const ITALY_LEAD_QUERIES = ROLE_TERMS.flatMap((r) => ITALY_REGIONS.map((g) => `site:linkedin.com/jobs/view ${r} ${g}`));
const SPONSORSHIP_LEAD_QUERIES = SPONSOR_ROLES.flatMap((r) => SPONSOR_COUNTRIES.filter(Boolean).map((c) => `site:linkedin.com/jobs/view ${r} "visa sponsorship" ${c}`));

const RESOLVE_SITES =
  "(site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:job-boards.greenhouse.io OR site:jobs.smartrecruiters.com OR site:apply.workable.com OR site:myworkdayjobs.com OR site:jobs.personio.com OR site:recruitee.com OR site:teamtailor.com OR site:jobs.eu.lever.co)";

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** n queries per run, spread across the whole list (roles AND platforms vary within a run, and slices don't overlap between runs). */
export function pickQueries(list: string[], seed: number, n: number): string[] {
  const len = list.length;
  const count = Math.min(n, len);
  let stride = Math.max(1, Math.round(len * 0.618));
  while (gcd(stride, len) !== 1) stride++;
  const start = (Math.abs(seed) * count) % len;
  return Array.from({ length: count }, (_, i) => list[(start + i * stride) % len]);
}

// ---- Run --------------------------------------------------------------------

export interface RunOptions {
  tracks?: Track[];
  onEvent?: (e: RunEvent) => void;
  /** Rotates which discovery queries this run uses. */
  seed?: number;
  /** Cap on Claude screenings per track per run (cost control). */
  maxScreens?: number;
}

export interface RunSummary {
  run_id: number;
  status: "ok" | "error";
  evaluated: number;
  added: number;
  budget_used: number;
  notes: string[];
}

// Workers Free allows 50 external subrequests per invocation. Cloudflare counts a few more than this meter does
// (redirect hops, Brave retries: production runs metered at 44 showed 48-50), so leave 10 spare.
const TOTAL_BUDGET = 40;
const LOG_MAX_EVENTS = 140;

function compact(e: RunEvent): RunEvent {
  const c: any = { ...e };
  for (const k of ["detail", "query", "message", "url"]) if (typeof c[k] === "string" && c[k].length > 220) c[k] = c[k].slice(0, 220) + "…";
  return c;
}

export async function runPipeline(env: Env, opts: RunOptions = {}): Promise<RunSummary> {
  const tracks = opts.tracks ?? ["italy-remote", "sponsorship"];
  const log: RunEvent[] = [];
  const emit = (e: RunEvent) => {
    if (log.length < LOG_MAX_EVENTS) log.push(compact(e));
    opts.onEvent?.(e);
  };
  await cleanupStaleRuns(env);
  const runId = await startRun(env);
  emit({ type: "start", run_id: runId, tracks });

  const notes: string[] = [];
  let evaluated = 0;
  let added = 0;
  let budgetUsed = 0;
  let status: "ok" | "error" = "ok";
  const perTrack = Math.floor(TOTAL_BUDGET / tracks.length);

  try {
    for (const track of tracks) {
      const budget = new Budget(perTrack);
      try {
        const r = await runTrack(env, track, budget, opts, emit, notes);
        evaluated += r.evaluated;
        added += r.added;
      } finally {
        budgetUsed += budget.used;
      }
    }
  } catch (err) {
    status = "error";
    const message = (err as Error).message;
    notes.push(`FATAL: ${message}`);
    emit({ type: "error", message, fatal: true });
  }

  try {
    await finishRun(env, runId, status, added, evaluated, notes.join(" | "), log);
  } catch (err) {
    console.error("finishRun failed:", (err as Error).message);
  }
  emit({ type: "done", run_id: runId, status, evaluated, added, budget_used: budgetUsed, notes });
  return { run_id: runId, status, evaluated, added, budget_used: budgetUsed, notes };
}

const RETRY_UNVERIFIED_AFTER_MS = 3 * 24 * 3600_000;
// The Brave key in use allows far more than 1 request/second; a short gap keeps runs quick and stays polite.
const BRAVE_GAP_MS = 400;

/** One thing to look at this run, whichever way it was found. */
interface Candidate {
  /** Canonical URL: the dedupe key and what's stored as the posting's source. */
  url: string;
  kind: SourceKind;
  /** Board / job system the posting lives on (Greenhouse, Workday, RemoteOK, ...). */
  board: string;
  /** Title-ish text used to triage and rank before spending a request on it. */
  hint: string;
  /** Employer job page, fetched live from its own job system. */
  info?: JobUrlInfo;
  /** Public-board listing whose text was fetched live from the board this run. */
  feed?: FeedItem;
  /** Set when found via a LinkedIn lead; recorded once the candidate has been judged. */
  leadKey?: string;
  /** Came from a company's own live job list: known open right now, so never a dead link. */
  crawled?: boolean;
  /** Full posting text when that job list already carried it (no per-posting fetch needed). */
  text?: string;
  title?: string;
  /** Same role posted for other locations: not screened separately; they share this candidate's verdict. */
  siblings?: string[];
  rank: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** Same company + same title once location decorations are stripped ("Engineer (remote in Poland)", "Engineer | Germany"). */
const roleKeyOf = (co: string, title: string) => co + ":" + title.toLowerCase().replace(/\(.*?\)/g, " ").split("|")[0].replace(/[^a-z0-9]+/g, " ").trim();
const leadKeyOf = (l: Lead) => `lead:${norm(l.company)}|${norm(searchableRole(l.role)).slice(0, 60)}`;


async function runTrack(
  env: Env,
  track: Track,
  budget: Budget,
  opts: RunOptions,
  emit: (e: RunEvent) => void,
  notes: string[],
): Promise<{ evaluated: number; added: number }> {
  const seed = opts.seed ?? Math.floor(Date.now() / (20 * 60_000));
  const italy = track === "italy-remote";
  const roomy = budget.max >= 40; // a lone track gets the whole invocation; two share it
  const plan = {
    searches: italy ? (roomy ? 4 : 2) : roomy ? 3 : 2,
    feeds: italy ? (roomy ? 3 : 1) : 0,
    leadQueries: 1,
    leadResolutions: italy ? (roomy ? 2 : 1) : roomy ? 2 : 1,
    crawls: roomy ? 6 : 3,
  };

  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (!candidates.has(c.url)) candidates.set(c.url, c);
  };
  const stats = { hits: 0, feedItems: 0, leads: 0, resolved: 0, triaged: 0, crawled: 0, crawlRoles: 0, crawlInScope: 0, crawlFiltered: 0, oracleDead: 0, oracleOut: 0 };
  const now = () => new Date().toISOString();
  const pending: SeenRow[] = [];
  // Every crawlable company we run into (dead links included: the company is still real) joins the crawl queue.
  const learned: { ats: Ats; slug: string; eu?: boolean; sponsors?: boolean }[] = [];
  // A company surfaced by a sponsorship search (whose query demands sponsorship wording) is a sponsorship candidate.
  const learn = (info: JobUrlInfo) => learned.push({ ats: info.ats, slug: info.company, eu: info.eu, sponsors: !italy });

  // 1. Employer job pages: search each job system's public pages for the target roles.
  for (const q of pickQueries(italy ? ITALY_QUERIES : SPONSORSHIP_QUERIES, seed, plan.searches)) {
    if (!budget.take()) break;
    const hits = await braveSearch(env.BRAVE_SEARCH_API_KEY, q, 20);
    stats.hits += hits.length;
    emit({ type: "search", track, query: q.slice(0, 140), hits: hits.length, purpose: "discover" });
    for (const h of hits) {
      const info = classifyJobUrl(h.url);
      if (!info) continue;
      const hint = h.title || h.description.slice(0, 100);
      const reason = titleTriage(h.title, h.description.slice(0, 200));
      if (reason) {
        stats.triaged++;
        continue;
      }
      // Only companies whose hit named a relevant role join the crawl queue (not, say, a care agency that mentions "visa").
      learn(info);
      add({ url: info.canonical, kind: "employer", board: BOARD_NAMES[info.ats], hint, info, rank: hintRank(hint) + freshnessRank(h.pageAgeDays) });
    }
    await sleep(BRAVE_GAP_MS);
  }

  // 2. Public job boards (no sign-in feeds). Italy track only: the sponsorship track needs the employer's own page.
  for (const { feed, variant } of pickFeeds(seed, plan.feeds)) {
    if (!budget.take(feed.cost ?? 1)) break;
    let items: FeedItem[] = [];
    try {
      items = await feed.fetch(variant);
    } catch (err) {
      console.error(`feed ${feed.id} failed: ${(err as Error).message}`);
    }
    stats.feedItems += items.length;
    emit({ type: "feed", track, board: feed.board, items: items.length });
    for (const it of items) {
      if (titleTriage(it.title)) {
        stats.triaged++;
        continue;
      }
      // Some boards link straight to the employer's own page: then verify it there, at the source.
      const info = classifyJobUrl(it.url);
      if (info) {
        learn(info);
        add({ url: info.canonical, kind: "employer", board: BOARD_NAMES[info.ats], hint: it.title, info, rank: hintRank(it.title) });
      } else {
        add({ url: canonicalUrl(it.url), kind: "board", board: it.board, hint: it.title, feed: it, rank: hintRank(it.title) + 1 });
      }
    }
  }

  // 3. LinkedIn leads: roles LinkedIn lists publicly, looked up on the employer's own job system.
  if (budget.left >= plan.leadQueries + plan.leadResolutions + 2) {
    const leadQuery = pickQueries(italy ? ITALY_LEAD_QUERIES : SPONSORSHIP_LEAD_QUERIES, seed, 1)[0];
    budget.take();
    const hits = await braveSearch(env.BRAVE_SEARCH_API_KEY, leadQuery, 20);
    emit({ type: "search", track, query: leadQuery.slice(0, 140), hits: hits.length, purpose: "linkedin" });
    await sleep(BRAVE_GAP_MS);

    const leads = new Map<string, { lead: Lead; rank: number }>();
    for (const h of hits) {
      if (!/(^|\.)linkedin\.com\/jobs\/view/i.test(h.url.replace(/^https?:\/\//, ""))) continue;
      const lead = parseLinkedInTitle(h.title);
      if (!lead || lead.company.length < 2 || !isResolvable(lead)) continue;
      if (titleTriage(lead.role, h.description.slice(0, 200))) {
        stats.triaged++;
        continue;
      }
      const key = leadKeyOf(lead);
      if (!leads.has(key)) leads.set(key, { lead, rank: hintRank(`${lead.role} ${h.title}`) });
    }
    stats.leads = leads.size;

    const cutoff = new Date(Date.now() - RETRY_UNVERIFIED_AFTER_MS).toISOString();
    const knownLeads = await getKnownUrls(env, [...leads.keys()], cutoff);
    const todo = [...leads.entries()]
      .filter(([k]) => !knownLeads.has(k))
      .sort((a, b) => b[1].rank - a[1].rank)
      .slice(0, plan.leadResolutions);

    for (const [key, { lead }] of todo) {
      if (!budget.take()) break;
      const role = searchableRole(lead.role).replace(/"/g, "");
      const company = lead.company.replace(/"/g, "");
      const found = await braveSearch(env.BRAVE_SEARCH_API_KEY, `"${company}" "${role}" ${RESOLVE_SITES}`, 10);
      emit({ type: "search", track, query: `${company} · ${role} (employer page lookup)`, hits: found.length, purpose: "resolve" });
      await sleep(BRAVE_GAP_MS);

      let match: { info: JobUrlInfo; title: string } | null = null;
      for (const f of found) {
        const info = classifyJobUrl(f.url);
        if (!info) continue;
        const text = `${f.title} ${f.description}`;
        if (companyMatches(lead.company, info.company, text) && roleMatches(role, text)) {
          match = { info, title: f.title };
          break;
        }
      }
      if (match) {
        stats.resolved++;
        learn(match.info);
        emit({ type: "lead", track, role: lead.role, company: lead.company, url: match.info.canonical, board: BOARD_NAMES[match.info.ats] });
        add({ url: match.info.canonical, kind: "linkedin", board: BOARD_NAMES[match.info.ats], hint: match.title || lead.role, info: match.info, leadKey: key, rank: hintRank(lead.role) + 2 });
      } else {
        emit({ type: "lead", track, role: lead.role, company: lead.company });
        pending.push({ id: key, date_evaluated: now(), decision: "unverified - no employer job page found for this LinkedIn lead", score: 0, source_url: key, board: LINKEDIN_BOARD });
      }
    }
  }

  // 3b. Company boards: crawl the job lists of companies we've learned about (new ones first). One request returns
  // every role a company has open right now — live by construction — with structured location/remote data that
  // rules out most postings for free, before any per-posting fetch or screening.
  await seedCompaniesIfEmpty(env).catch((e) => console.error("seedCompanies failed:", (e as Error).message));
  await upsertCompanies(env, learned).catch((e) => console.error("upsertCompanies failed:", (e as Error).message));
  const crawlUpdates: { key: string; status: "ok" | "gone" | "fail"; openRoles: number }[] = [];
  const roleGroups = new Map<string, Candidate>();
  // What each crawled company has open right now (canonical URL -> its list entry): the free liveness check below.
  const liveByCompany = new Map<string, Map<string, BoardJob>>();
  const maxScreens = opts.maxScreens ?? 14;
  // Keep enough budget to fetch and screen a full set of candidates; crawling (1 request per company) uses the rest.
  const reserve = 14;
  const crawlCap = roomy ? (italy ? 18 : 22) : 4;
  let due: CompanyRow[] = await pickCompaniesToCrawl(env, plan.crawls, track).catch(() => []);
  while (due.length) {
    for (const co of due) {
      if (!budget.take()) break;
      const res = await crawlBoard({ ats: co.ats, slug: co.slug, eu: !!co.eu });
      stats.crawled++;
      if (res.status === "gone") liveByCompany.set(co.key, new Map());
      if (res.status !== "ok") {
        crawlUpdates.push({ key: co.key, status: res.status, openRoles: 0 });
        emit({ type: "crawl", track, board: BOARD_NAMES[co.ats], company: co.slug, jobs: 0, in_scope: 0, ok: false });
        continue;
      }
      stats.crawlRoles += res.jobs.length;
      const listing = new Map<string, BoardJob>();
      for (const j of res.jobs) listing.set(classifyJobUrl(j.url)?.canonical ?? j.url, j);
      liveByCompany.set(co.key, listing);
      const scoped = res.jobs
        .filter((j) => !inScope(track, j))
        .map((j) => ({ j, rank: hintRank(`${j.title} ${j.location}`) }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 6);
      stats.crawlInScope += scoped.length;
      crawlUpdates.push({ key: co.key, status: "ok", openRoles: scoped.length });
      emit({ type: "crawl", track, board: BOARD_NAMES[co.ats], company: co.slug, jobs: res.jobs.length, in_scope: scoped.length, ok: true });
      for (const { j, rank } of scoped) {
        const info = classifyJobUrl(j.url);
        if (!info) continue;
        // When the list already carries the full text, apply the free text checks now (no request spent on rejects).
        if (j.text && quickReject(track, j.text)) {
          stats.crawlFiltered++;
          continue;
        }
        const ageDays = j.postedAt ? (Date.now() - Date.parse(j.postedAt)) / 86400000 : NaN;
        const recent = Number.isFinite(ageDays) && ageDays <= 45 ? 1 : 0;
        const cand: Candidate = { url: info.canonical, kind: "employer", board: BOARD_NAMES[info.ats], hint: `${j.title} — ${j.location}`, title: j.title, info, text: j.text, crawled: true, rank: rank + 4 + recent + (j.text ? 1 : 0) };
        const rk = roleKeyOf(co.key, j.title);
        const lead = roleGroups.get(rk);
        if (!lead) {
          roleGroups.set(rk, cand);
          candidates.set(cand.url, cand); // supersedes a bare search hit for the same posting: it carries live, structured data
        } else if (cand.rank > lead.rank) {
          // A better location variant of the same role: it takes over, the earlier one becomes its sibling.
          candidates.delete(lead.url);
          cand.siblings = [...(lead.siblings ?? []), lead.url];
          roleGroups.set(rk, cand);
          candidates.set(cand.url, cand);
        } else {
          (lead.siblings ??= []).push(cand.url);
        }
      }
    }
    await markCrawled(env, crawlUpdates.splice(0)).catch((e) => console.error("markCrawled failed:", (e as Error).message));
    // A thin pool of candidates (common on the sponsorship track, where most postings never mention sponsorship) means
    // spare budget is better spent reading more company boards than idling.
    if (stats.crawled >= crawlCap || candidates.size >= maxScreens * 2 || budget.left <= reserve) break;
    due = await pickCompaniesToCrawl(env, Math.min(3, crawlCap - stats.crawled), track).catch(() => []);
  }

  // A crawled company's live list settles its search hits for free: absent = closed; present but out of scope for this
  // track (wrong location, not a target role) = not worth a fetch. Hits from uncrawled companies still get fetched.
  for (const c of [...candidates.values()]) {
    if (c.crawled || !c.info || !CRAWLABLE.includes(c.info.ats)) continue;
    const listing = liveByCompany.get(companyKey(c.info.ats, c.info.company));
    if (!listing) continue;
    const entry = listing.get(c.url);
    const settle = (decision: string) => {
      candidates.delete(c.url);
      pending.push({ id: c.url, date_evaluated: now(), decision, score: 0, source_url: c.url, board: c.board });
      if (c.leadKey) pending.push({ id: c.leadKey, date_evaluated: now(), decision: "lead - resolved to an employer page", score: 0, source_url: c.leadKey, board: LINKEDIN_BOARD });
    };
    if (!entry) {
      settle("skip - posting no longer listed on its company's job board");
      stats.oracleDead++;
      continue;
    }
    const why = inScope(track, entry);
    if (why) {
      settle(`skip - prefilter: ${why} (per the company's live job list)`);
      stats.oracleOut++;
    } else {
      c.rank += 3; // confirmed live and in scope
    }
  }

  // 4. Drop what we've already judged or already track (chunked D1 lookups).
  const all = [...candidates.values()];
  const known = await getKnownUrls(env, all.map((c) => c.url), new Date(Date.now() - RETRY_UNVERIFIED_AFTER_MS).toISOString());
  const fresh = all.filter((c) => !known.has(c.url));
  // Each dead link costs a request to discover. Boards whose pages have mostly turned out dead (stale search index)
  // go to the back of the queue, so a run's limited requests go to boards that are actually returning live postings.
  const yields = await boardStats(env).catch(() => []);
  const mostlyDead = new Set(yields.filter((s) => s.checked >= 8 && s.dead / s.checked >= 0.7).map((s) => s.board));
  for (const c of fresh) {
    if (!c.crawled && mostlyDead.has(c.board)) c.rank -= 3;
    // Many Workday tenants refuse the public job API, so those candidates often can't be verified at all.
    if (c.info?.ats === "workday") c.rank -= 2;
  }
  fresh.sort((a, b) => b.rank - a.rank);
  if (mostlyDead.size) notes.push(`${track}: deprioritised mostly-dead boards: ${[...mostlyDead].join(", ")}`);
  emit({ type: "discovered", track, hits: stats.hits, job_pages: all.length, fresh: fresh.length, feed_items: stats.feedItems, leads: stats.leads, triaged: stats.triaged, crawled: stats.crawled, crawl_roles: stats.crawlInScope });

  // 5. Verify live, pre-filter, screen.
  const seenRow = (c: Candidate, decision: string, score = 0, shareVerdict = false) => {
    pending.push({ id: c.url, date_evaluated: now(), decision, score, source_url: c.url, board: c.board });
    if (shareVerdict) for (const s of c.siblings ?? []) pending.push({ id: s, date_evaluated: now(), decision: `skip - same role as ${c.url}: ${decision}`, score, source_url: s, board: c.board });
    if (c.leadKey) pending.push({ id: c.leadKey, date_evaluated: now(), decision: "lead - resolved to an employer page", score: 0, source_url: c.leadKey, board: LINKEDIN_BOARD });
  };
  const claude = { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL };

  let evaluated = 0;
  let added = 0;
  let screens = 0;
  let consecutiveErrors = 0;
  let budgetHit = false;
  const blockedHosts = new Set<string>();

  try {
    for (const c of fresh) {
      if (screens >= maxScreens) {
        notes.push(`${track}: screening cap (${maxScreens}) reached`);
        break;
      }
      // An employer page costs a fetch plus the screening; a board listing or a crawled list entry already has its text.
      const need = c.info && c.text === undefined ? 2 : 1;
      if (budget.left < need) {
        budgetHit = true;
        if (budget.left < 1) break;
        continue;
      }

      // Some Workday tenants refuse the public job API. Once one has, its other postings aren't worth a request either.
      if (c.info?.ats === "workday" && blockedHosts.has(new URL(c.url).host)) {
        seenRow(c, "unverified - this employer's job system blocks the public job API");
        emit({ type: "candidate", track, url: c.url, outcome: "unverified", detail: "employer's Workday blocks the public job API — can't verify", board: c.board });
        continue;
      }

      let fetched: Fetched | null;
      if (c.info && c.text !== undefined) {
        fetched = { text: c.text, title: c.title };
      } else if (c.info) {
        budget.take();
        fetched = await fetchPosting(c.info);
      } else {
        fetched = { text: c.feed!.text, title: c.feed!.title };
        // The same role may already be tracked from another board: don't pay to screen it twice.
        if (await postingExists(env, c.feed!.company, c.feed!.title)) {
          seenRow(c, "skip - duplicate of an existing tracker entry (same company and title)");
          emit({ type: "candidate", track, url: c.url, outcome: "skipped", detail: "already in the tracker via another board", title: c.feed!.title, board: c.board });
          continue;
        }
      }
      if (fetched?.blocked) {
        blockedHosts.add(new URL(c.url).host);
        seenRow(c, "unverified - this employer's job system blocks the public job API");
        emit({ type: "candidate", track, url: c.url, outcome: "unverified", detail: "employer's job system blocks the public job API — can't verify", board: c.board });
        continue;
      }
      if (!fetched) {
        seenRow(c, "unverified - could not fetch live source this run");
        emit({ type: "candidate", track, url: c.url, outcome: "unverified", detail: "couldn't fetch the live posting", board: c.board });
        continue;
      }
      if (fetched.gone) {
        seenRow(c, "skip - posting no longer exists at its source (HTTP 404/410)");
        emit({ type: "candidate", track, url: c.url, outcome: "expired", detail: `posting no longer exists (404 at ${c.board})`, board: c.board });
        continue;
      }
      if (fetched.expired) {
        seenRow(c, "skip - posting closed/expired per its own page");
        emit({ type: "candidate", track, url: c.url, outcome: "expired", detail: "posting is closed", title: fetched.title, board: c.board });
        continue;
      }
      const reject = quickReject(track, fetched.text, { remoteBoard: c.kind === "board" && !c.board.startsWith("Hacker News") });
      if (reject) {
        seenRow(c, `skip - prefilter: ${reject}`, 0, true);
        emit({ type: "candidate", track, url: c.url, outcome: "skipped", detail: reject, title: fetched.title, board: c.board });
        continue;
      }

      if (track === "sponsorship" && c.info && CRAWLABLE.includes(c.info.ats)) await markCompanySponsors(env, c.info.ats, c.info.company).catch(() => {});

      screens++;
      budget.take();
      let screened;
      try {
        screened = await screenPosting(claude, track, c.url, fetched.text);
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof FatalApiError) throw err;
        consecutiveErrors++;
        const message = (err as Error).message;
        emit({ type: "candidate", track, url: c.url, outcome: "error", detail: message.slice(0, 200), title: fetched.title, board: c.board });
        if (consecutiveErrors >= 3) throw new Error(`Claude API failing repeatedly: ${message}`);
        continue;
      }

      const verdict = judge(track, screened, fetched.text);
      const r = verdict.result;
      evaluated++;

      if (!verdict.qualifies) {
        seenRow(c, `${verdict.decision} (score ${r.score})`, r.score, true);
        emit({
          type: "candidate", track, url: c.url, outcome: "screened", company: r.company, title: r.title,
          score: r.score, decision: verdict.decision, board: c.board,
          detail: r.hard_filter_failures[0] ?? (track === "sponsorship" && !verdict.sponsorshipVerified ? "sponsorship not verified in the posting text" : r.one_line_reason),
        });
        continue;
      }

      const company = r.company || c.info?.company || c.feed?.company || "";
      const title = r.title || fetched.title || "Untitled role";
      if (await postingExists(env, company, title)) {
        seenRow(c, `skip - duplicate of an existing tracker entry (score ${r.score})`, r.score, true);
        emit({ type: "candidate", track, url: c.url, outcome: "skipped", detail: "already in the tracker (same company and title)", company, title, score: r.score, board: c.board });
        continue;
      }

      await insertPosting(env, {
        id: postingId(company, title, c.url),
        company,
        title,
        track,
        location: r.location,
        source_url: c.url,
        salary: r.salary,
        score: r.score,
        decision: verdict.decision,
        confidence: r.confidence,
        remote_eligibility: r.remote_eligibility,
        seniority_detected: r.seniority_detected,
        matched_requirements: r.matched_requirements,
        gaps: r.gaps,
        one_line_reason: r.one_line_reason,
        tailored_summary: r.tailoring_note,
        sponsorship_country: track === "sponsorship" ? r.sponsorship_country || null : null,
        sponsorship_verified: track === "sponsorship" && verdict.sponsorshipVerified,
        sponsorship_evidence: track === "sponsorship" && verdict.sponsorshipVerified ? r.sponsorship_evidence : null,
        source_board: c.board,
        source_kind: c.kind,
        date_found: now(),
      });
      seenRow(c, `${verdict.decision} (score ${r.score}) - added`, r.score, true);
      added++;
      if (c.info && CRAWLABLE.includes(c.info.ats)) await bumpCompanyAdded(env, c.info.ats, c.info.company).catch(() => {});
      emit({ type: "candidate", track, url: c.url, outcome: "added", company, title, score: r.score, decision: verdict.decision, detail: r.one_line_reason, board: c.board });
    }
  } finally {
    await saveSeenBatch(env, pending).catch((e) => console.error("saveSeenBatch failed:", (e as Error).message));
  }
  if (budgetHit) notes.push(`${track}: subrequest budget exhausted`);

  notes.push(
    `${track}: ${plan.searches} board searches (${stats.hits} hits)` +
      (plan.feeds ? ` + ${plan.feeds} public feeds (${stats.feedItems} items)` : "") +
      ` + ${stats.leads} LinkedIn leads (${stats.resolved} resolved to employer pages)` +
      ` + ${stats.crawled} company boards crawled (${stats.crawlRoles} open roles → ${stats.crawlInScope} in scope, ${stats.crawlFiltered} more dropped on their text; the lists ruled out ${stats.oracleDead} closed and ${stats.oracleOut} ineligible search hits without a fetch)` +
      ` → ${all.length} candidates, ${fresh.length} new, ${stats.triaged} triaged out by title; screened ${evaluated}, added ${added}`,
  );
  return { evaluated, added };
}

function postingId(company: string, title: string, canonical: string): string {
  const slug = `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${slug}-${(h >>> 0).toString(36)}`;
}
