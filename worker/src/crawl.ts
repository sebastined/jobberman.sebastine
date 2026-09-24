// Company job-board crawl. A search hit tells us a company uses (say) Greenhouse; the company's own public
// job list then gives every role it has open *right now*, with location and remote flags. That removes the two
// costliest wastes of the search-only approach: dead links (a list only contains live roles) and postings whose
// location rules Italy out (checked here, for free, before any per-posting fetch or screening).
// Every endpoint below is the ATS's public, no-sign-in job list.

import type { Ats } from "./canon";
import { htmlToText } from "./sources";
import { titleTriage } from "./rules";
import type { Track } from "./types";

export interface BoardJob {
  /** Canonical job URL on the ATS (same form the search path produces, so dedupe lines up). */
  url: string;
  title: string;
  location: string;
  /** true = remote, false = on-site/hybrid, null = the list doesn't say. */
  remote: boolean | null;
  postedAt: string | null;
  /** Full posting text, when the list endpoint already includes it (saves the per-posting fetch). */
  text?: string;
}

export interface CrawlTarget {
  ats: Ats;
  slug: string;
  eu?: boolean;
}

export type CrawlResult = { status: "ok"; jobs: BoardJob[] } | { status: "gone" } | { status: "fail" };

export const CRAWLABLE: Ats[] = ["greenhouse", "ashby", "smartrecruiters", "workable", "breezy", "lever", "recruitee", "personio"];

const MAX_BYTES = 1_500_000;
const UA = { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0; personal job search)", Accept: "application/json, application/xml, text/xml, */*" };

type Fetched = { status: "ok"; text: string } | { status: "gone" } | { status: "fail" };

async function getText(url: string, init: RequestInit = {}): Promise<Fetched> {
  const res = await fetch(url, { ...init, headers: { ...UA, ...((init.headers as Record<string, string>) || {}) }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 404 || res.status === 410) return { status: "gone" };
  if (!res.ok) return { status: "fail" };
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return { status: "fail" };
  const text = await res.text();
  return text.length > MAX_BYTES ? { status: "fail" } : { status: "ok", text };
}

function parseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ASHBY_LIST_QUERY =
  "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id title locationName workplaceType employmentType secondaryLocations { locationName } } } }";

export async function crawlBoard(t: CrawlTarget): Promise<CrawlResult> {
  try {
    switch (t.ats) {
      case "greenhouse":
        return await greenhouse(t);
      case "ashby":
        return await ashby(t);
      case "smartrecruiters":
        return await smartrecruiters(t);
      case "workable":
        return await workable(t);
      case "breezy":
        return await breezy(t);
      case "lever":
        return await lever(t);
      case "recruitee":
        return await recruitee(t);
      case "personio":
        return await personio(t);
      default:
        return { status: "fail" };
    }
  } catch (err) {
    console.error(`crawl ${t.ats}/${t.slug} failed: ${(err as Error).message}`);
    return { status: "fail" };
  }
}

async function greenhouse(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://${t.eu ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io"}/v1/boards/${encodeURIComponent(t.slug)}/jobs`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j?.jobs)) return { status: "fail" };
  const dir = t.eu ? "job-boards.eu.greenhouse.io" : "job-boards.greenhouse.io";
  return {
    status: "ok",
    jobs: j.jobs.map((x: any) => {
      const location = String(x.location?.name ?? "");
      return { url: `https://${dir}/${t.slug}/jobs/${x.id}`, title: String(x.title ?? ""), location, remote: /remote/i.test(location) ? true : null, postedAt: x.first_published ?? x.updated_at ?? null };
    }),
  };
}

async function ashby(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName: "ApiJobBoardWithTeams", variables: { organizationHostedJobsPageName: t.slug }, query: ASHBY_LIST_QUERY }),
  });
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  // A removed board answers 200 with a null jobBoard.
  if (!j?.data?.jobBoard) return { status: "gone" };
  const posts: any[] = j.data.jobBoard.jobPostings ?? [];
  return {
    status: "ok",
    jobs: posts.map((p) => {
      const wp = String(p.workplaceType ?? "");
      return {
        url: `https://jobs.ashbyhq.com/${encodeURIComponent(t.slug)}/${p.id}`,
        title: String(p.title ?? ""),
        location: [p.locationName, ...(p.secondaryLocations ?? []).map((s: any) => s.locationName)].filter(Boolean).join(" / "),
        remote: wp === "Remote" ? true : wp === "OnSite" || wp === "Hybrid" ? false : null,
        postedAt: null,
      };
    }),
  };
}

async function smartrecruiters(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(t.slug)}/postings?limit=100`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j?.content)) return { status: "fail" };
  return {
    status: "ok",
    jobs: j.content.map((x: any) => {
      const l = x.location ?? {};
      return {
        url: `https://jobs.smartrecruiters.com/${t.slug}/${x.id}`,
        title: String(x.name ?? ""),
        location: String(l.fullLocation || [l.city, l.region, String(l.country ?? "").toUpperCase()].filter(Boolean).join(", ")),
        remote: l.remote === true ? true : l.hybrid === true || l.remote === false ? false : null,
        postedAt: x.releasedDate ?? null,
      };
    }),
  };
}

async function workable(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t.slug)}`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j?.jobs)) return { status: "fail" };
  return {
    status: "ok",
    jobs: j.jobs.map((x: any) => {
      const title = String(x.title ?? "");
      return {
        url: `https://apply.workable.com/${t.slug}/j/${x.shortcode}`,
        title,
        location: [x.city, x.state, x.country].filter(Boolean).join(", "),
        remote: x.telecommuting === true ? true : x.telecommuting === false && !/remote/i.test(title) ? false : null,
        postedAt: x.published_on ?? x.created_at ?? null,
      };
    }),
  };
}

async function breezy(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://${encodeURIComponent(t.slug)}.breezy.hr/json`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j)) return { status: "fail" };
  return {
    status: "ok",
    jobs: j.map((x: any) => ({
      url: `https://${t.slug}.breezy.hr/p/${x.id}`,
      title: String(x.name ?? ""),
      location: String(x.location?.name ?? ""),
      remote: x.location?.is_remote === true ? true : x.location?.is_remote === false ? false : null,
      postedAt: x.published_date ?? null,
    })),
  };
}

async function lever(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://${t.eu ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${encodeURIComponent(t.slug)}?mode=json`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j)) return { status: "fail" };
  return {
    status: "ok",
    jobs: j.map((x: any) => {
      const wp = String(x.workplaceType ?? "");
      const location = [...new Set([x.categories?.location, ...(x.categories?.allLocations ?? [])].filter(Boolean))].join(" / ");
      const lists = (x.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`).join("\n\n");
      const text = [x.text, [location, x.categories?.commitment, wp, x.country].filter(Boolean).join(" · "), "", x.descriptionPlain ?? htmlToText(x.description ?? ""), lists, x.additionalPlain ?? htmlToText(x.additional ?? "")].join("\n").slice(0, 12000);
      return {
        url: `https://jobs${t.eu ? ".eu" : ""}.lever.co/${t.slug}/${x.id}`,
        title: String(x.text ?? ""),
        location,
        remote: wp === "remote" ? true : wp === "onsite" || wp === "hybrid" ? false : null,
        postedAt: x.createdAt ? new Date(x.createdAt).toISOString() : null,
        text,
      };
    }),
  };
}

async function recruitee(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://${encodeURIComponent(t.slug)}.recruitee.com/api/offers/`);
  if (r.status !== "ok") return r;
  const j = parseJson(r.text);
  if (!Array.isArray(j?.offers)) return { status: "fail" };
  return {
    status: "ok",
    jobs: j.offers
      .filter((o: any) => !o.status || o.status === "published")
      .map((o: any) => {
        const location = String(o.location || [o.city, o.country].filter(Boolean).join(", "));
        const title = String(o.title ?? "");
        const text = [title, location ? `Location: ${location}` : "", o.remote === true ? "Remote" : "", "", htmlToText(String(o.description ?? "")), htmlToText(String(o.requirements ?? ""))].filter((s) => s !== "").join("\n").slice(0, 12000);
        return { url: `https://${t.slug}.recruitee.com/o/${o.slug}`, title, location, remote: o.remote === true ? true : null, postedAt: o.published_at ?? null, text };
      }),
  };
}

async function personio(t: CrawlTarget): Promise<CrawlResult> {
  const r = await getText(`https://${encodeURIComponent(t.slug)}.jobs.personio.com/xml?language=en`);
  if (r.status !== "ok") return r;
  if (!/<workzag-jobs/.test(r.text)) return { status: "fail" };
  const jobs: BoardJob[] = [];
  for (const m of r.text.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const b = m[1];
    const one = (tag: string) => (b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const id = one("id");
    const title = one("name");
    if (!id || !title) continue;
    const offices = [...b.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((x) => x[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()).filter(Boolean);
    const sections = [...b.matchAll(/<jobDescription>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>/g)].map((s) => `${s[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()}\n${htmlToText(s[2].replace(/<!\[CDATA\[|\]\]>/g, ""))}`);
    const location = offices.join(" / ");
    const text = [title, location ? `Location: ${location}` : "", one("employmentType"), one("seniority"), "", ...sections].filter((s) => s !== "").join("\n").slice(0, 12000);
    jobs.push({ url: `https://${t.slug}.jobs.personio.com/job/${id}`, title, location, remote: offices.some((o) => /remote/i.test(o)) ? true : null, postedAt: one("createdAt") || null, text });
  }
  return { status: "ok", jobs };
}

// ---- eligibility: decide from the list alone whether a role is worth a per-posting fetch -----------------

// A whole company board is visible here, so be pickier about role family than for search hits.
const CRAWL_ROLE =
  /security|secops|devsecops|cyber|infosec|\biam\b|identity|access management|\bgrc\b|\b(it|information|technology|cloud)\s+(risk|audit|compliance|governance)|soc\s?2|iso\s?27001|incident response|threat|vulnerab|penetration|\bsre\b|site reliability|reliability engineer|devops|infrastructure|network (engineer|architect|admin)|firewall|fortinet|cisco|sysadmin|systems? administrator|it operations|platform engineer|kubernetes/i;
// "Cloud" alone is too loose ("Cloudflare", "Cloud Commerce Analyst"): it must sit with an engineering noun.
const CLOUD_WORD = /\bcloud\b/i;
const CLOUD_ROLE_NOUN = /engineer|architect|admin|operations|\bops\b|specialist|security|\bsre\b|reliability|devops|infrastructure|platform/i;

const GENERIC_WORDS = /\b(remote|anywhere|worldwide|global|distributed|home[- ]?based|work from home|hybrid|flexible|virtual)\b/gi;
// Region-wide wording that admits a candidate living in Italy.
const REGION_WIDE = /europe|emea|\beu\b|\beea\b|worldwide|anywhere|global|italy|italia|milan|milano|rome|roma|turin|torino|bologna|florence|naples|palermo|catania/i;
const UK_WORDS = /\b(uk|united kingdom|england|scotland|wales|britain|london|manchester|edinburgh|cardiff|belfast|bristol)\b/i;

/**
 * A reason the role can't work for a candidate living in Italy, or null. Permissive when the list is vague
 * ("Remote", "Distributed"), strict when it names specific places: a list of other countries — even European ones
 * ("Remote - Poland", "Remote - Israel / Poland / UK") — means "residents of those countries only".
 */
export function italyEligibility(j: BoardJob): string | null {
  const loc = j.location.trim();
  if (j.remote === false) return "on-site or hybrid role";
  const remoteish = j.remote === true || /\bremote\b|\banywhere\b|\bworldwide\b|\bdistributed\b|home[- ]?based|work from home/i.test(loc + " " + j.title);
  if (!remoteish) return "no remote option listed";
  const specific = loc.replace(GENERIC_WORDS, "").replace(/[^a-z]/gi, "");
  if (specific && !REGION_WIDE.test(loc)) return UK_WORDS.test(loc) ? "remote only within the UK" : "remote only within specific countries, none of them Italy";
  return null;
}

const SPONSOR_TARGET =
  /united states|\busa?\b|u\.s\.|canada|united kingdom|\buk\b|england|scotland|wales|ireland|dublin|france|paris|estonia|tallinn|lithuania|vilnius|czech|prague|hungary|budapest|germany|berlin|munich|portugal|lisbon|porto|poland|warsaw|krakow|wroclaw|toronto|vancouver|montreal|ottawa|calgary|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|washington|remote/i;
const SPONSOR_NON_TARGET =
  /india|brazil|brasil|mexico|argentina|colombia|philippines|singapore|japan|china|korea|australia|new zealand|israel|uae|dubai|saudi|south africa|nigeria|kenya|spain|italy|italia|netherlands|sweden|denmark|norway|finland|switzerland|austria|belgium|greece|romania|bulgaria|turkey|ukraine|cyprus|malta|luxembourg|croatia|serbia|slovakia|slovenia/i;

/** Sponsorship track: on-site is fine, but the role must not be clearly outside the target countries. */
export function sponsorshipEligibility(j: BoardJob): string | null {
  const loc = j.location.trim();
  if (loc && SPONSOR_NON_TARGET.test(loc) && !SPONSOR_TARGET.test(loc)) return "location outside the target countries";
  return null;
}

/** Roles from a crawled board worth spending requests on: right role family, and possible for this track. */
export function inScope(track: Track, j: BoardJob): string | null {
  if (!CRAWL_ROLE.test(j.title) && !(CLOUD_WORD.test(j.title) && CLOUD_ROLE_NOUN.test(j.title))) return "not a target role";
  const t = titleTriage(j.title);
  if (t) return t;
  return track === "italy-remote" ? italyEligibility(j) : sponsorshipEligibility(j);
}
