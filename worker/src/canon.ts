// Recognises real job-detail pages on known ATS platforms and reduces each to a
// canonical URL, so the same posting is deduplicated however a search engine
// happened to spell its link. Anything that isn't a job-detail page on a known
// ATS (aggregators, listicles, company index pages) returns null: those are
// discovery noise, and the primary-source rule means they can never be the
// evidence a posting is judged on anyway.

export type Ats =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "personio"
  | "teamtailor"
  | "recruitee"
  | "workable"
  | "workday"
  | "breezy"
  | "jazzhr"
  | "join"
  | "jobvite"
  | "rippling";

export const BOARD_NAMES: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  personio: "Personio",
  teamtailor: "Teamtailor",
  recruitee: "Recruitee",
  workable: "Workable",
  workday: "Workday",
  breezy: "Breezy HR",
  jazzhr: "JazzHR",
  join: "Join.com",
  jobvite: "Jobvite",
  rippling: "Rippling",
};

export interface JobUrlInfo {
  ats: Ats;
  canonical: string;
  company: string;
  id: string;
  eu?: boolean;
  /** Extra parts some job systems need to build their API URL (Workday: site + path). */
  meta?: Record<string, string>;
  raw: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function classifyJobUrl(raw: string): JobUrlInfo | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  let m: RegExpMatchArray | null;

  // Greenhouse: (job-)boards[.eu].greenhouse.io/<company>/jobs/<id>
  if ((m = host.match(/^(?:job-)?boards(\.eu)?\.greenhouse\.io$/))) {
    const eu = !!m[1];
    const dir = eu ? "job-boards.eu.greenhouse.io" : "job-boards.greenhouse.io";
    let pm = path.match(/^\/([\w-]+)\/jobs\/(\d+)$/);
    if (pm) return { ats: "greenhouse", canonical: `https://${dir}/${pm[1]}/jobs/${pm[2]}`, company: pm[1], id: pm[2], eu, raw };
    // embed form: /embed/job_app?for=<company>&token=<id>
    if (path === "/embed/job_app") {
      const company = u.searchParams.get("for");
      const id = u.searchParams.get("token");
      if (company && id && /^\d+$/.test(id)) {
        return { ats: "greenhouse", canonical: `https://${dir}/${company}/jobs/${id}`, company, id, eu, raw };
      }
    }
    return null;
  }
  // Greenhouse public API form (seen in older records): boards-api[.eu].greenhouse.io/v1/boards/<company>/jobs/<id>
  if ((m = host.match(/^boards-api(\.eu)?\.greenhouse\.io$/))) {
    const pm = path.match(/^\/v1\/boards\/([\w-]+)\/jobs\/(\d+)$/);
    if (pm) {
      const eu = !!m[1];
      const dir = eu ? "job-boards.eu.greenhouse.io" : "job-boards.greenhouse.io";
      return { ats: "greenhouse", canonical: `https://${dir}/${pm[1]}/jobs/${pm[2]}`, company: pm[1], id: pm[2], eu, raw };
    }
    return null;
  }

  // Lever: jobs[.eu].lever.co/<company>/<uuid>[/apply]
  if ((m = host.match(/^jobs(\.eu)?\.lever\.co$/))) {
    const pm = path.match(new RegExp(`^/([\\w.-]+)/(${UUID})(?:/apply)?$`, "i"));
    if (pm) {
      const eu = !!m[1];
      const id = pm[2].toLowerCase();
      return { ats: "lever", canonical: `https://jobs${eu ? ".eu" : ""}.lever.co/${pm[1]}/${id}`, company: pm[1], id, eu, raw };
    }
    return null;
  }

  // Ashby: jobs.ashbyhq.com/<company>/<uuid>[/application]
  if (host === "jobs.ashbyhq.com") {
    const pm = path.match(new RegExp(`^/([^/]+)/(${UUID})(?:/application)?$`, "i"));
    if (pm) {
      const id = pm[2].toLowerCase();
      const company = decodeURIComponent(pm[1]);
      return { ats: "ashby", canonical: `https://jobs.ashbyhq.com/${pm[1]}/${id}`, company, id, raw };
    }
    return null;
  }

  // SmartRecruiters: jobs.smartrecruiters.com/<Company>/<id>[-slug]
  if (host === "jobs.smartrecruiters.com") {
    const pm = path.match(/^\/([\w.-]+)\/(\d{6,})(?:-[^/]*)?$/);
    if (pm) return { ats: "smartrecruiters", canonical: `https://jobs.smartrecruiters.com/${pm[1]}/${pm[2]}`, company: pm[1], id: pm[2], raw };
    return null;
  }

  // Personio: <company>.jobs.personio.(com|de)/job/<id>
  if ((m = host.match(/^([\w-]+)\.jobs\.personio\.(?:com|de)$/))) {
    const pm = path.match(/^\/job\/(\d+)$/);
    if (pm) return { ats: "personio", canonical: `https://${m[1]}.jobs.personio.com/job/${pm[1]}`, company: m[1], id: pm[1], raw };
    return null;
  }

  // Teamtailor: <company>.teamtailor.com/jobs/<id>-<slug>
  if ((m = host.match(/^([\w-]+)\.teamtailor\.com$/))) {
    const pm = path.match(/^\/jobs\/(\d+)(?:-[^/]*)?$/);
    if (pm) return { ats: "teamtailor", canonical: `https://${m[1]}.teamtailor.com/jobs/${pm[1]}`, company: m[1], id: pm[1], raw };
    return null;
  }

  // Recruitee: <company>.recruitee.com/o/<slug>
  if ((m = host.match(/^([\w-]+)\.recruitee\.com$/))) {
    const pm = path.match(/^\/o\/([\w-]+)$/);
    if (pm) return { ats: "recruitee", canonical: `https://${m[1]}.recruitee.com/o/${pm[1]}`, company: m[1], id: pm[1], raw };
    return null;
  }

  // Workable: apply.workable.com/<company>/j/<id>
  if (host === "apply.workable.com") {
    const pm = path.match(/^\/([\w-]+)\/j\/([\w]+)$/);
    if (pm) return { ats: "workable", canonical: `https://apply.workable.com/${pm[1]}/j/${pm[2]}`, company: pm[1], id: pm[2], raw };
    return null;
  }

  // Workday: <tenant>.wd<N>.myworkdayjobs.com/[locale/]<site>/job/<location>/<title>_<reqid>
  if ((m = host.match(/^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/))) {
    const pm = path.match(/^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/([\w-]+)\/job\/(.+)$/);
    if (pm) {
      // Search engines often index the "apply" page (…/apply/autofillWithResume); the posting is the part before it.
      const rest = pm[2].replace(/\/apply(?:\/.*)?$/, "");
      const reqId = (rest.match(/_([A-Za-z0-9-]+)$/) || [])[1] || rest;
      return { ats: "workday", canonical: `https://${host}/${pm[1]}/job/${rest}`, company: m[1], id: reqId, meta: { site: pm[1], rest }, raw };
    }
    return null;
  }

  // Breezy HR: <company>.breezy.hr/p/<hex>[-slug]
  if ((m = host.match(/^([\w-]+)\.breezy\.hr$/))) {
    const pm = path.match(/^\/p\/([0-9a-f]{8,})(?:-[^/]*)?$/i);
    if (pm) return { ats: "breezy", canonical: `https://${m[1]}.breezy.hr/p/${pm[1].toLowerCase()}`, company: m[1], id: pm[1], raw };
    return null;
  }

  // JazzHR: <company>.applytojob.com/apply/<id>[/slug]
  if ((m = host.match(/^([\w-]+)\.applytojob\.com$/))) {
    const pm = path.match(/^\/apply\/([A-Za-z0-9]+)(?:\/[^/]*)?$/);
    if (pm) return { ats: "jazzhr", canonical: `https://${m[1]}.applytojob.com/apply/${pm[1]}`, company: m[1], id: pm[1], raw };
    return null;
  }

  // Join.com: join.com/companies/<company>/<id>-<slug>
  if (host === "join.com" || host === "www.join.com") {
    const pm = path.match(/^\/companies\/([\w-]+)\/(\d+)(?:-[^/]*)?$/);
    if (pm) return { ats: "join", canonical: `https://join.com/companies/${pm[1]}/${pm[2]}`, company: pm[1], id: pm[2], raw };
    return null;
  }

  // Jobvite: jobs.jobvite.com/<company>/job/<id>
  if (host === "jobs.jobvite.com") {
    const pm = path.match(/^\/([\w-]+)\/job\/(\w+)$/);
    if (pm) return { ats: "jobvite", canonical: `https://jobs.jobvite.com/${pm[1]}/job/${pm[2]}`, company: pm[1], id: pm[2], raw };
    return null;
  }

  // Rippling: ats.rippling.com/<company>/jobs/<uuid>
  if (host === "ats.rippling.com") {
    const pm = path.match(new RegExp(`^/([\\w-]+)/jobs/(${UUID})$`, "i"));
    if (pm) return { ats: "rippling", canonical: `https://ats.rippling.com/${pm[1]}/jobs/${pm[2].toLowerCase()}`, company: pm[1], id: pm[2], raw };
    return null;
  }

  return null;
}

/** Canonical form for any URL: the ATS canonical if recognised, else a tidied version of the input. */
export function canonicalUrl(raw: string): string {
  const info = classifyJobUrl(raw);
  if (info) return info.canonical;
  try {
    const u = new URL(raw);
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gh_src|lever-|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}
