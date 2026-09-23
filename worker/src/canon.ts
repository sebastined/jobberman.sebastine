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
  | "workable";

export interface JobUrlInfo {
  ats: Ats;
  canonical: string;
  company: string;
  id: string;
  eu?: boolean;
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
