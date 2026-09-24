// Discovery (Brave Search) and verification (fetch the posting from its own ATS).
// Nothing here is allowed to judge a posting from a search snippet: a posting is
// only ever screened from text fetched live from its primary source this run.

import { FatalApiError } from "./budget";
import type { JobUrlInfo } from "./canon";

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  /** Days since the search engine last saw the page change (its page_age); null when it has no age. */
  pageAgeDays: number | null;
}

/**
 * One Brave query. A dead key or exhausted quota is fatal for the run; a network hiccup or a 5xx is not —
 * it's retried once, then treated as "no results for this query" so one bad request can't sink the whole run.
 */
export async function braveSearch(apiKey: string, query: string, count = 20): Promise<SearchHit[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 429) {
        throw new FatalApiError(`Brave Search rejected the request (HTTP ${res.status}) — check the API key / monthly quota`);
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt === 0) continue;
        return [];
      }
      const data = (await res.json()) as any;
      const results: any[] = data?.web?.results ?? [];
      return results.map((r) => {
        const t = r.page_age ? Date.parse(r.page_age) : NaN;
        return { title: String(r.title ?? ""), url: String(r.url ?? ""), description: String(r.description ?? ""), pageAgeDays: Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 86400000)) : null };
      });
    } catch (err) {
      if (err instanceof FatalApiError) throw err;
      if (attempt === 1) return [];
    }
  }
  return [];
}

export interface Fetched {
  text: string;
  title?: string;
  /** The source answered 404/410: the posting no longer exists (a final verdict, not worth retrying). */
  gone?: boolean;
  /** True when the posting's own structured data says it has closed. */
  expired?: boolean;
  /** The employer's job system refuses the public job API (some Workday tenants): the posting can't be verified this way. */
  blocked?: boolean;
}

const MAX_TEXT = 12000;

/** Fetch a posting from its own ATS. Returns null if it can't be fetched live right now. */
export async function fetchPosting(info: JobUrlInfo): Promise<Fetched | null> {
  try {
    switch (info.ats) {
      case "greenhouse":
        return await fromGreenhouse(info);
      case "lever":
        return await fromLever(info);
      case "ashby":
        return await fromAshby(info);
      case "smartrecruiters":
        return await fromSmartRecruiters(info);
      case "workable":
        return await fromWorkable(info);
      case "workday":
        return await fromWorkday(info);
      case "rippling":
        return await fromRippling(info.canonical);
      case "join":
        return await fromJoin(info.canonical);
      default:
        // Personio, Teamtailor, Recruitee, Breezy, JazzHR, Jobvite: the page's own JobPosting JSON-LD
        // where present, otherwise the readable page text.
        return await fromHtml(info.canonical);
    }
  } catch (err) {
    if (err instanceof GoneError) return { text: "", gone: true };
    if (err instanceof BlockedError) return { text: "", blocked: true };
    console.error(`fetchPosting failed for ${info.canonical}: ${(err as Error).message}`);
    return null;
  }
}

/** The posting's own source says it no longer exists (HTTP 404/410). */
class GoneError extends Error {}

/** The job system answered 401/403 to its own public job API. */
class BlockedError extends Error {}

function assertLive(res: Response): void {
  if (res.status === 404 || res.status === 410) throw new GoneError(String(res.status));
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  assertLive(res);
  if (!res.ok) return null;
  return res.json();
}

async function fromGreenhouse(info: JobUrlInfo): Promise<Fetched | null> {
  const host = info.eu ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
  const j = await getJson(`https://${host}/v1/boards/${info.company}/jobs/${info.id}`);
  if (!j) return null;
  const text = [j.title, j.location?.name, "", htmlToText(j.content ?? "")].filter((s) => s !== undefined).join("\n");
  return { text: clip(text), title: j.title };
}

async function fromLever(info: JobUrlInfo): Promise<Fetched | null> {
  const host = info.eu ? "api.eu.lever.co" : "api.lever.co";
  const j = await getJson(`https://${host}/v0/postings/${info.company}/${info.id}`);
  if (!j) return null;
  const lists = (j.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`).join("\n\n");
  const text = [
    j.text,
    [j.categories?.location, j.categories?.commitment, j.workplaceType, j.country].filter(Boolean).join(" · "),
    "",
    j.descriptionPlain ?? htmlToText(j.description ?? ""),
    lists,
    j.additionalPlain ?? htmlToText(j.additional ?? ""),
  ].join("\n");
  return { text: clip(text), title: j.text };
}

const ASHBY_QUERY =
  "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title locationName workplaceType employmentType descriptionHtml isListed } }";

async function fromAshby(info: JobUrlInfo): Promise<Fetched | null> {
  const res = await fetch("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: { organizationHostedJobsPageName: info.company, jobPostingId: info.id },
      query: ASHBY_QUERY,
    }),
  });
  assertLive(res);
  if (!res.ok) return null;
  const p = ((await res.json()) as any)?.data?.jobPosting;
  // Ashby answers 200 with a null jobPosting once a posting has been taken down.
  if (!p) throw new GoneError("null jobPosting");
  const text = [p.title, [p.locationName, p.workplaceType, p.employmentType].filter(Boolean).join(" · "), "", htmlToText(p.descriptionHtml ?? "")].join("\n");
  return { text: clip(text), title: p.title, expired: p.isListed === false };
}

async function fromSmartRecruiters(info: JobUrlInfo): Promise<Fetched | null> {
  const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${info.company}/postings/${info.id}`);
  if (!j) return null;
  const s = j.jobAd?.sections ?? {};
  const loc = j.location ? [j.location.city, j.location.region, j.location.country, j.location.remote ? "Remote" : ""].filter(Boolean).join(", ") : "";
  const text = [
    j.name,
    loc,
    "",
    htmlToText(s.jobDescription?.text ?? ""),
    htmlToText(s.qualifications?.text ?? ""),
    htmlToText(s.additionalInformation?.text ?? ""),
  ].join("\n");
  return { text: clip(text), title: j.name };
}

/** Workable's public job-detail API (their apply pages are a client-side app with no readable HTML). */
async function fromWorkable(info: JobUrlInfo): Promise<Fetched | null> {
  const j = await getJson(`https://apply.workable.com/api/v2/accounts/${info.company}/jobs/${info.id}`);
  if (!j) return null;
  const loc = j.location ? [j.location.city, j.location.region, j.location.country].filter(Boolean).join(", ") : "";
  const text = [
    j.title,
    [loc, j.workplace, j.remote ? "Remote" : "", j.type].filter(Boolean).join(" · "),
    "",
    htmlToText(j.description ?? ""),
    htmlToText(j.requirements ?? ""),
    htmlToText(j.benefits ?? ""),
  ].join("\n");
  return { text: clip(text), title: j.title, expired: j.state != null && j.state !== "published" };
}

/** Workday's public cxs job-detail endpoint. Some tenants answer 403; that's "couldn't verify", never "gone". */
async function fromWorkday(info: JobUrlInfo): Promise<Fetched | null> {
  const host = new URL(info.canonical).host;
  const res = await fetch(`https://${host}/wday/cxs/${info.company}/${info.meta?.site}/job/${info.meta?.rest}`, { headers: { Accept: "application/json" } });
  assertLive(res);
  if (res.status === 401 || res.status === 403) throw new BlockedError(String(res.status));
  if (!res.ok) return null;
  const p = ((await res.json()) as any)?.jobPostingInfo;
  if (!p) return null;
  const loc = [p.location, ...(p.additionalLocations || []), p.country?.descriptor, p.remoteType].filter(Boolean).join(" · ");
  const text = [p.title, loc, p.timeType ? `Time type: ${p.timeType}` : "", "", htmlToText(p.jobDescription ?? "")].join("\n");
  return { text: clip(text), title: p.title, expired: p.canApply === false };
}

/** The Next.js data blob a career page ships with, or null if the page isn't one / is a plain error. */
async function nextData(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0)", "Accept-Language": "en" } });
  assertLive(res);
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 900_000);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Rippling: the posting is at apiData.jobPost; a closed job simply has no jobPost. */
async function fromRippling(url: string): Promise<Fetched | null> {
  const data = await nextData(url);
  if (!data) return null;
  const p = data?.props?.pageProps?.apiData?.jobPost;
  if (!p) throw new GoneError("no jobPost");
  const text = [
    p.name,
    [(p.workLocations || []).join(" / "), p.employmentType?.id].filter(Boolean).join(" · "),
    p.companyName ? `Company: ${p.companyName}` : "",
    "",
    htmlToText(p.description?.company ?? ""),
    htmlToText(p.description?.role ?? ""),
  ].filter((s) => s !== "").join("\n");
  return { text: clip(text), title: p.name };
}

/** Join.com: the posting is at initialState.job. remoteType COUNTRY means "must live in that country". */
async function fromJoin(url: string): Promise<Fetched | null> {
  const data = await nextData(url);
  if (!data) return null;
  const j = data?.props?.pageProps?.initialState?.job;
  if (!j?.title) throw new GoneError("no job");
  const where = [j.city?.cityName, j.city?.countryName ?? j.country?.name].filter(Boolean).join(", ");
  const body = j.description || [j.intro, j.tasks, j.requirements, j.benefits, j.outro].filter(Boolean).join("\n\n");
  const text = [
    j.title,
    [where, j.workplaceType, j.remoteType ? `remote type: ${j.remoteType}${j.remoteType === "COUNTRY" ? " (must be based in that country)" : ""}` : "", j.employmentType?.name].filter(Boolean).join(" · "),
    j.company?.name ? `Company: ${j.company.name}` : "",
    "",
    htmlToText(String(body)),
  ].filter((s) => s !== "").join("\n");
  return { text: clip(text), title: j.title, expired: j.status !== "ONLINE" };
}

const CLOSED_PAGE = /no longer (exists|available|open|accepting)|has (been )?(filled|closed|expired|removed)|is (now )?closed|job (listing )?(not found|does not exist)|page (you (are looking for|requested)|not found)|Job Seeker Support\s+What is Jobvite/i;

/** Personio / Teamtailor / Recruitee / Breezy / JazzHR / Pinpoint / Jobvite / BambooHR: prefer the page's own JobPosting JSON-LD, else its readable text. */
async function fromHtml(url: string): Promise<Fetched | null> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0)", "Accept-Language": "en" } });
  assertLive(res);
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("html")) return null;
  const html = (await res.text()).slice(0, 600_000);

  const ld = extractJobPostingLd(html);
  if (ld) return ld;

  // No structured data: prefer the page's <main> region so site navigation doesn't crowd out the posting.
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  const text = htmlToText(main);
  // Some systems (Jobvite, …) serve a closed job as a normal 200 page with a short "no longer exists" notice.
  if (text.length < 6000 && CLOSED_PAGE.test(text)) throw new GoneError("closed-page notice");
  return text.length > 300 ? { text: clip(text) } : null;
}

function extractJobPostingLd(html: string): Fetched | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const nodes: any[] = Array.isArray(data) ? data : data?.["@graph"] ? data["@graph"] : [data];
    const jp = nodes.find((n) => n && (n["@type"] === "JobPosting" || (Array.isArray(n["@type"]) && n["@type"].includes("JobPosting"))));
    if (!jp) continue;

    const locs = [].concat(jp.jobLocation ?? []).map((l: any) => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry?.name ?? l?.address?.addressCountry].filter(Boolean).join(", "));
    const applicant = [].concat(jp.applicantLocationRequirements ?? []).map((a: any) => a?.name).filter(Boolean);
    const sal = jp.baseSalary?.value;
    const salary = sal ? `${sal.minValue ?? sal.value ?? ""}${sal.maxValue ? "–" + sal.maxValue : ""} ${jp.baseSalary.currency ?? ""}`.trim() : "";
    const valid = jp.validThrough ? Date.parse(jp.validThrough) : NaN;

    const text = [
      jp.title,
      jp.hiringOrganization?.name ? `Company: ${jp.hiringOrganization.name}` : "",
      locs.length ? `Location: ${locs.join(" | ")}` : "",
      jp.jobLocationType ? `Location type: ${jp.jobLocationType}` : "",
      applicant.length ? `Applicant location requirements: ${applicant.join(", ")}` : "",
      jp.employmentType ? `Employment type: ${[].concat(jp.employmentType).join(", ")}` : "",
      salary ? `Salary: ${salary}` : "",
      "",
      htmlToText(String(jp.description ?? "")),
    ].filter((s) => s !== "").join("\n");
    return { text: clip(text), title: jp.title, expired: Number.isFinite(valid) && valid < Date.now() };
  }
  return null;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”" };

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|ndash|mdash|rsquo|lsquo|ldquo|rdquo|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** HTML (possibly entity-encoded, as Greenhouse ships it) -> readable text. */
export function htmlToText(html: string): string {
  let s = html;
  // Greenhouse returns its HTML entity-escaped; decode first so the tags become strippable.
  if (!/<[a-z][\s\S]*>/i.test(s) && /&lt;[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}
