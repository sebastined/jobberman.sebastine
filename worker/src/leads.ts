// LinkedIn as a *lead* source, never a scraped one. Search engines already index LinkedIn's public job
// pages; we read only what the search result itself shows (its title/snippet), and never request a
// LinkedIn page. Each lead (a role + company) is then looked up on the employer's own sign-in-free job
// system, and only that page — fetched live and screened like any other — can become a tracker entry.

export interface Lead {
  role: string;
  company: string;
}

const clean = (s: string) =>
  s
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:in|at)$/i, "")
    .replace(/^[\s\-–—|:]+|[\s\-–—|:…]+$/g, "")
    .trim();

/**
 * LinkedIn public job titles come in a few shapes:
 *   "Pencil hiring Security Engineer - Remote in EMEA"
 *   "Senior Security Engineer - Remote EMEA at Aircall"
 *   "Senior Security Engineer (Europe, Remote) - Intel 471"
 *   "NEVERHACK Italy sta assumendo Cybersecurity GRC Engineer in Napoli"
 */
export function parseLinkedInTitle(rawTitle: string): Lead | null {
  const t = clean(rawTitle);
  if (t.length < 8) return null;
  let m = t.match(/^(.+?) (?:is )?(?:hiring|sta assumendo|recrute|sucht|is looking for) (?:an? )?(.+?)(?: in [^-–—|]+)?$/i);
  if (m) return { company: clean(m[1]), role: clean(m[2]) };
  m = t.match(/^(.+) at ([^—–|]+?)(?:\s+[—–-]\s+.*)?$/i);
  if (m) return { role: clean(m[1]), company: clean(m[2]) };
  m = t.match(/^(.+?)\s+[-–—]\s+([^-–—]+?)(?:\s*\(.*\))?$/);
  // A trailing "- contract or permanent" / "- fully remote" is a job attribute, not a company: employer names start with a capital.
  if (m && m[2].length < 40 && /^[A-Z0-9]/.test(m[2].trim()) && !/remote|hybrid|onsite|emea|europe|\beu\b|permanent|contract|full[- ]?time|part[- ]?time/i.test(m[2])) return { role: clean(m[1]), company: clean(m[2]) };
  return { role: t, company: "" };
}

/** Recruiters and job-repost sites that list roles on LinkedIn: not employers, so looking them up on an employer's job system is pointless. */
const NOT_EMPLOYERS =
  /(recruit|staffing|headhunt|search partners?|talent (?:acquisition|solutions|partners))|^(hire ?feed|hired|onhires|jobs ?ai|jobgether|talent\.com|lensa|dice|adzuna|jooble|randstad|adecco|manpower|hays|michael page|page personnel|robert half|harnham|experis|modis|nigel frank|jefferson frank|sthree|computer futures|client server|harvey nash|la fosse|spectrum it|cathcart|lorien|huxley|morgan mckinley|jobs via dice|hire ?right|talentbridge|s\.?i\.? systems)\b/i;

export function isResolvable(l: Lead): boolean {
  return l.role.length >= 8 && !NOT_EMPLOYERS.test(l.company.trim());
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const ROLE_STOP = new Set([
  "remote", "emea", "europe", "european", "union", "eu", "hybrid", "senior", "sr", "junior", "jr", "lead", "staff", "principal",
  "the", "and", "of", "for", "in", "at", "an", "to", "or", "uk", "us", "usa", "full", "time", "fulltime", "all", "genders",
  "outside", "ir35", "contract", "contractor", "global", "worldwide", "anywhere", "americas", "apac", "latam", "est", "cet", "italy",
]);

function roleTokens(role: string): string[] {
  return role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !ROLE_STOP.has(t) && !/^\d+$/.test(t));
}

/** Does a search hit's title/description describe (essentially) the role the lead named? */
export function roleMatches(role: string, hitText: string): boolean {
  const toks = roleTokens(role);
  if (toks.length === 0) return false;
  const hay = hitText.toLowerCase();
  const need = toks.length <= 2 ? toks.length : Math.ceil(toks.length * 0.7);
  return toks.filter((t) => hay.includes(t)).length >= need;
}

/** Does the employer page (its ATS company slug, or the hit's own title/description) belong to the lead's company? */
export function companyMatches(company: string, atsSlug: string, hitText: string): boolean {
  const c = alnum(company);
  if (c.length < 3) return false;
  const s = alnum(atsSlug);
  if (s.length >= 3 && (s === c || (c.length >= 5 && s.includes(c)) || (s.length >= 5 && c.includes(s)))) return true;
  return c.length >= 5 && alnum(hitText).includes(c);
}

/** A role string trimmed to what a search engine can match well (no location/parenthetical tails). */
export function searchableRole(role: string): string {
  return role
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+[-–—|]\s+(remote|hybrid|onsite|full[- ]?remote|emea|europe|eu\b).*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
