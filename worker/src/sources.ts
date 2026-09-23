// Discovery (Brave Search) and verification (fetch the posting from its own ATS).
// Nothing here is allowed to judge a posting from a search snippet: a posting is
// only ever screened from text fetched live from its primary source this run.

import { FatalApiError } from "./budget";
import type { JobUrlInfo } from "./canon";

export interface SearchHit {
  title: string;
  url: string;
}

export async function braveSearch(apiKey: string, query: string, count = 10): Promise<SearchHit[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
  );
  if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 429) {
    throw new FatalApiError(`Brave Search rejected the request (HTTP ${res.status}) — check the API key / monthly quota`);
  }
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const results: any[] = data?.web?.results ?? [];
  return results.map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? "") }));
}

export interface Fetched {
  text: string;
  title?: string;
  /** The source answered 404/410: the posting no longer exists (a final verdict, not worth retrying). */
  gone?: boolean;
  /** True when the posting's own structured data says it has closed. */
  expired?: boolean;
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
      default:
        return await fromHtml(info.canonical);
    }
  } catch (err) {
    if (err instanceof GoneError) return { text: "", gone: true };
    console.error(`fetchPosting failed for ${info.canonical}: ${(err as Error).message}`);
    return null;
  }
}

/** The posting's own source says it no longer exists (HTTP 404/410). */
class GoneError extends Error {}

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

/** Personio / Teamtailor / Recruitee / Workable: prefer the page's own JobPosting JSON-LD, else stripped text. */
async function fromHtml(url: string): Promise<Fetched | null> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0)", "Accept-Language": "en" } });
  assertLive(res);
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("html")) return null;
  const html = (await res.text()).slice(0, 600_000);

  const ld = extractJobPostingLd(html);
  if (ld) return ld;

  const text = htmlToText(html);
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
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|ndash|mdash|rsquo|lsquo|ldquo|rdquo|#39);/g, (e) => ENTITIES[e] ?? e).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
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
