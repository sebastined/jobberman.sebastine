// The complete list of places this pipeline looks, and how each one's postings are verified.
// Nothing here needs a login: every source serves its listings to anyone.

import { BOARD_NAMES, type Ats } from "./canon";
import { CRAWLABLE } from "./crawl";
import { FEEDS } from "./feeds";
import type { Track } from "./types";

export const LINKEDIN_BOARD = "LinkedIn (leads)";

export interface BoardInfo {
  name: string;
  group: "employer" | "public" | "linkedin";
  tracks: Track[];
  how: string;
}

const BOTH: Track[] = ["italy-remote", "sponsorship"];

const ATS_HOW: Record<Ats, string> = {
  greenhouse: "employer's Greenhouse job API, fetched live",
  lever: "employer's Lever postings API, fetched live",
  ashby: "employer's Ashby public API, fetched live",
  smartrecruiters: "employer's SmartRecruiters posting API, fetched live",
  workable: "employer's Workable public API, fetched live",
  workday: "employer's Workday public job endpoint, fetched live",
  rippling: "employer's Rippling job page data, fetched live",
  join: "employer's Join.com job page data, fetched live",
  personio: "employer's Personio page (JobPosting data), fetched live",
  teamtailor: "employer's Teamtailor page (JobPosting data), fetched live",
  recruitee: "employer's Recruitee page (JobPosting data), fetched live",
  breezy: "employer's Breezy HR page (JobPosting data), fetched live",
  jazzhr: "employer's JazzHR page (JobPosting data), fetched live",
  jobvite: "employer's Jobvite page, fetched live",
};

export const BOARD_CATALOG: BoardInfo[] = [
  ...(Object.keys(BOARD_NAMES) as Ats[]).map((a) => ({ name: BOARD_NAMES[a], group: "employer" as const, tracks: BOTH, how: ATS_HOW[a] + (CRAWLABLE.includes(a) ? "; each company's full live job list is crawled too" : "") })),
  ...FEEDS.map((f) => ({ name: f.board, group: "public" as const, tracks: ["italy-remote"] as Track[], how: `public listing, fetched live from ${f.board} (${f.note})` })),
  {
    name: LINKEDIN_BOARD,
    group: "linkedin",
    tracks: BOTH,
    how: "roles LinkedIn lists publicly are read from search results only, then looked up on the employer's own job system and verified there; LinkedIn itself is never fetched",
  },
];
