// Public, no-sign-in job feeds. Each one is a job board's own live listing, fetched right now, so an item's
// presence in the response is the "still open on that board" check. Items are labelled as board listings
// (not the employer's own page) everywhere they surface. They only feed the Italy-remote track: the
// sponsorship track needs the employer's own page, so it never uses these.

import { htmlToText } from "./sources";

export interface FeedItem {
  board: string;
  url: string;
  title: string;
  company: string;
  location: string;
  text: string;
  expired?: boolean;
}

export interface FeedDef {
  id: string;
  board: string;
  /** Rough size of one response, so callers can budget CPU/time. */
  note: string;
  /** Outbound requests one fetch makes (counts against the per-invocation limit). Default 1. */
  cost?: number;
  fetch: (variant: number) => Promise<FeedItem[]>;
}

const UA = { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0; personal job search)", Accept: "application/json, application/rss+xml, text/xml, */*" };

// Titles worth screening at all (cheap first pass; Claude does the real judging).
const ROLE_OK =
  /security|secops|devsecops|cyber|infosec|iam\b|identity|access management|compliance|grc\b|governance|risk|audit|privacy|soc\b|incident|threat|vulnerab|cloud|sre\b|reliability|devops|platform|infrastructure|network|firewall|zero trust|kubernetes|pki|crypto/i;

/** Location strings that admit a candidate in Italy: unspecified, remote, worldwide, or Europe-wide. */
function regionOk(loc: string): boolean {
  const l = (loc || "").trim();
  if (!l) return true;
  return /worldwide|anywhere|global|europe|emea|\beu\b|eea|italy|italia|\bremote\b|\bc?e[et]?t\b|gmt|utc/i.test(l);
}

/** Stricter than regionOk, for boards that are mostly US: needs an explicit non-US location as well as "remote". */
const EUROPE_PLACES = /europe|emea|worldwide|anywhere|global|italy|italia|ireland|united kingdom|\buk\b|germany|france|spain|portugal|poland|netherlands|belgium|sweden|denmark|finland|norway|austria|switzerland|czech|romania|greece|hungary|estonia|lithuania|latvia|croatia|bulgaria/i;

function tidy(items: FeedItem[], max = 14): FeedItem[] {
  return items.filter((i) => ROLE_OK.test(i.title) && regionOk(i.location) && i.url).slice(0, max);
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function compose(board: string, title: string, company: string, location: string, extra: string, html: string): string {
  return [title, company ? `Company: ${company}` : "", location ? `Location: ${location}` : "", extra, `Listed on: ${board}`, "", htmlToText(html)].filter((s) => s !== "").join("\n");
}

const REMOTEOK_TAGS = ["security", "devops", "cloud", "compliance"];
const REMOTIVE_TERMS = ["security", "devops", "cloud", "compliance"];
const JOBICY_TAGS = ["security", "devops", "cloud"];

export const FEEDS: FeedDef[] = [
  {
    id: "remoteok",
    board: "RemoteOK",
    note: "JSON, filtered by tag server-side",
    async fetch(v) {
      const j = await getJson(`https://remoteok.com/api?tag=${REMOTEOK_TAGS[v % REMOTEOK_TAGS.length]}`);
      if (!Array.isArray(j)) return [];
      return tidy(
        j
          .filter((x: any) => x?.position)
          .map((x: any) => ({
            board: "RemoteOK",
            url: String(x.url || x.apply_url || ""),
            title: String(x.position),
            company: String(x.company || ""),
            location: String(x.location || ""),
            text: compose("RemoteOK", String(x.position), String(x.company || ""), String(x.location || ""), (x.tags || []).length ? `Tags: ${x.tags.join(", ")}` : "", String(x.description || "")),
          })),
      );
    },
  },
  {
    id: "remotive",
    board: "Remotive",
    note: "JSON, filtered by search term server-side",
    async fetch(v) {
      const j = await getJson(`https://remotive.com/api/remote-jobs?search=${REMOTIVE_TERMS[v % REMOTIVE_TERMS.length]}&limit=40`);
      return tidy(
        (j?.jobs || []).map((x: any) => ({
          board: "Remotive",
          url: String(x.url || ""),
          title: String(x.title || ""),
          company: String(x.company_name || ""),
          location: String(x.candidate_required_location || ""),
          text: compose("Remotive", String(x.title || ""), String(x.company_name || ""), String(x.candidate_required_location || ""), [x.job_type, x.salary].filter(Boolean).join(" · "), String(x.description || "")),
        })),
      );
    },
  },
  {
    id: "jobicy",
    board: "Jobicy",
    note: "JSON, filtered by tag + region server-side",
    async fetch(v) {
      const j = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=30&geo=europe&tag=${JOBICY_TAGS[v % JOBICY_TAGS.length]}`);
      return tidy(
        (j?.jobs || []).map((x: any) => ({
          board: "Jobicy",
          url: String(x.url || ""),
          title: String(x.jobTitle || ""),
          company: String(x.companyName || ""),
          location: Array.isArray(x.jobGeo) ? x.jobGeo.join(", ") : String(x.jobGeo || ""),
          text: compose("Jobicy", String(x.jobTitle || ""), String(x.companyName || ""), Array.isArray(x.jobGeo) ? x.jobGeo.join(", ") : String(x.jobGeo || ""), [x.jobLevel, x.jobType].flat().filter(Boolean).join(" · "), String(x.jobDescription || x.jobExcerpt || "")),
        })),
      );
    },
  },
  {
    id: "himalayas",
    board: "Himalayas",
    note: "JSON, filtered by keyword server-side",
    async fetch(v) {
      const j = await getJson(`https://himalayas.app/jobs/api/search?q=${REMOTIVE_TERMS[v % REMOTIVE_TERMS.length]}&limit=30`);
      return tidy(
        (j?.jobs || []).map((x: any) => {
          const loc = (x.locationRestrictions || []).join(", ");
          return {
            board: "Himalayas",
            url: String(x.applicationLink || x.guid || ""),
            title: String(x.title || ""),
            company: String(x.companyName || ""),
            location: loc,
            expired: x.expiryDate ? Date.parse(x.expiryDate) < Date.now() : false,
            text: compose("Himalayas", String(x.title || ""), String(x.companyName || ""), loc, [x.seniority ? `Seniority: ${[].concat(x.seniority).join("/")}` : "", x.minSalary ? `Salary: ${x.minSalary}-${x.maxSalary} ${x.currency || ""}` : ""].filter(Boolean).join(" · "), String(x.description || x.excerpt || "")),
          };
        }),
      ).filter((i) => !i.expired);
    },
  },
  {
    id: "wwr",
    board: "We Work Remotely",
    note: "RSS (DevOps & Sysadmin category)",
    async fetch() {
      const res = await fetch("https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss", { headers: UA, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return [];
      const xml = await res.text();
      const items: FeedItem[] = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        const tag = (t: string) => (b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        const full = tag("title");
        const [company, ...rest] = full.split(": ");
        const title = rest.join(": ") || full;
        const region = tag("region");
        items.push({
          board: "We Work Remotely",
          url: tag("link"),
          title,
          company: rest.length ? company : "",
          location: region,
          text: compose("We Work Remotely", title, rest.length ? company : "", region, tag("type"), tag("description")),
        });
      }
      return tidy(items);
    },
  },
];

FEEDS.push(
  {
    id: "workingnomads",
    board: "Working Nomads",
    note: "JSON of current remote jobs, filtered by title here",
    async fetch() {
      const j = await getJson("https://www.workingnomads.com/api/exposed_jobs/");
      if (!Array.isArray(j)) return [];
      return tidy(
        j.map((x: any) => ({
          board: "Working Nomads",
          url: String(x.url || ""),
          title: String(x.title || ""),
          company: String(x.company_name || ""),
          location: String(x.location || ""),
          text: compose("Working Nomads", String(x.title || ""), String(x.company_name || ""), String(x.location || ""), [x.category_name, x.tags].filter(Boolean).join(" · "), String(x.description || "")),
        })),
      );
    },
  },
  {
    id: "themuse",
    board: "The Muse",
    note: "public JSON, IT category, remote-flexible; Europe-located roles only",
    async fetch(v) {
      const j = await getJson(`https://www.themuse.com/api/public/jobs?category=Computer%20and%20IT&location=Flexible%20%2F%20Remote&page=${(v % 5) + 1}`);
      return tidy(
        (j?.results || [])
          .map((x: any) => {
            const loc = (x.locations || []).map((l: any) => l.name).join(", ");
            return {
              board: "The Muse",
              url: String(x.refs?.landing_page || ""),
              title: String(x.name || ""),
              company: String(x.company?.name || ""),
              location: loc,
              text: compose("The Muse", String(x.name || ""), String(x.company?.name || ""), loc, (x.levels || []).map((l: any) => l.name).join(", "), String(x.contents || "")),
            };
          })
          .filter((i: FeedItem) => EUROPE_PLACES.test(i.location)),
      );
    },
  },
  {
    id: "jobspresso",
    board: "Jobspresso",
    note: "RSS of remote jobs",
    async fetch() {
      const res = await fetch("https://jobspresso.co/feed/?post_type=job_listing", { headers: UA, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return [];
      const xml = await res.text();
      const items: FeedItem[] = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        const tag = (t: string) => (b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        // <dc:creator> carries "Company<br>⚲ Location"
        const [company, where] = tag("dc:creator").split(/<br\s*\/?>/i);
        const location = (where || "").replace(/&nbsp;|⚲/g, " ").replace(/\s+/g, " ").trim();
        const title = tag("title");
        items.push({ board: "Jobspresso", url: tag("link"), title, company: (company || "").trim(), location, text: compose("Jobspresso", title, (company || "").trim(), location, "", tag("content:encoded") || tag("description")) });
      }
      return tidy(items);
    },
  },
  {
    id: "hn",
    board: "Hacker News (Who is hiring)",
    note: "the current monthly thread, searched by keyword; each comment is the employer's own post",
    cost: 2,
    async fetch(v) {
      const threads = await getJson("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=4");
      const story = (threads?.hits || []).find((h: any) => /^Ask HN: Who is hiring\?/i.test(h.title || ""));
      if (!story) return [];
      const term = ["security", "devops", "SRE OR reliability", "cloud OR infrastructure"][v % 4];
      const j = await getJson(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${story.objectID}&query=${encodeURIComponent(term)}&hitsPerPage=40`);
      return tidy(
        (j?.hits || [])
          .filter((x: any) => x.comment_text)
          .map((x: any) => {
            const plain = htmlToText(String(x.comment_text));
            const header = plain.split("\n")[0].slice(0, 160);
            return {
              board: "Hacker News (Who is hiring)",
              url: `https://news.ycombinator.com/item?id=${x.objectID}`,
              title: header,
              company: header.split("|")[0].trim().slice(0, 60),
              location: header,
              text: `${header}\nListed on: Hacker News (Who is hiring), posted by the employer\n\n${plain}`.slice(0, 12000),
            };
          }),
      );
    },
  },
);

/** Which feeds to hit this run (a couple per run, rotating), and the variant (tag/term) each should use. */
export function pickFeeds(seed: number, n: number): { feed: FeedDef; variant: number }[] {
  const out: { feed: FeedDef; variant: number }[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.abs(seed) * n + i;
    out.push({ feed: FEEDS[k % FEEDS.length], variant: Math.floor(k / FEEDS.length) });
  }
  return out;
}
