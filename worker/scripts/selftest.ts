// Self-test for the pure logic that guards what reaches the tracker.
//   npx esbuild scripts/selftest.ts --bundle --platform=node --format=esm --outfile=.tmp/selftest.mjs && node .tmp/selftest.mjs
import { canonicalUrl, classifyJobUrl } from "../src/canon";
import { evidenceInText, freshnessRank, hintRank, judge, quickReject, titleTriage } from "../src/rules";
import { htmlToText } from "../src/sources";
import { isResolvable, parseBoardTitle, parseLinkedInTitle, roleMatches, companyMatches, searchableRole } from "../src/leads";
import { pickQueries } from "../src/pipeline";
import { africaEligibility, inScope, italyEligibility, italyHybridEligibility, sponsorshipEligibility, ukEligibility, type BoardJob } from "../src/crawl";
import type { ScreenResult } from "../src/types";

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failed++;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- URL classification / canonicalisation ----
check("greenhouse job-boards", classifyJobUrl("https://job-boards.greenhouse.io/anthropic/jobs/5397319008?gh_src=x")?.canonical === "https://job-boards.greenhouse.io/anthropic/jobs/5397319008");
check("greenhouse legacy boards host", classifyJobUrl("https://boards.greenhouse.io/planetlabs/jobs/5773506")?.canonical === "https://job-boards.greenhouse.io/planetlabs/jobs/5773506");
check("greenhouse EU keeps region", classifyJobUrl("https://job-boards.eu.greenhouse.io/bitpanda/jobs/4699355101")?.eu === true);
check("greenhouse embed form", classifyJobUrl("https://boards.greenhouse.io/embed/job_app?for=nebius&token=4537289101")?.canonical === "https://job-boards.greenhouse.io/nebius/jobs/4537289101");
check("greenhouse api form", classifyJobUrl("https://boards-api.greenhouse.io/v1/boards/form3/jobs/8628358002")?.canonical === "https://job-boards.greenhouse.io/form3/jobs/8628358002");
check("greenhouse company index rejected", classifyJobUrl("https://job-boards.greenhouse.io/gitlab") === null);
check("lever strips /apply", classifyJobUrl("https://jobs.lever.co/airalo/9c046f9e-38a7-4f84-a045-e3d9cf3a3c27/apply")?.canonical === "https://jobs.lever.co/airalo/9c046f9e-38a7-4f84-a045-e3d9cf3a3c27");
check("lever EU host", classifyJobUrl("https://jobs.eu.lever.co/prima/47cfe444-120e-477f-b169-6dff57383874")?.eu === true);
check("lever company index rejected", classifyJobUrl("https://jobs.lever.co/jobgether") === null);
check("ashby strips /application", classifyJobUrl("https://jobs.ashbyhq.com/ygo/e0b8615d-77e0-436d-86a1-99cdba9c8b53/application?locationId=1")?.canonical === "https://jobs.ashbyhq.com/ygo/e0b8615d-77e0-436d-86a1-99cdba9c8b53");
check("ashby company page rejected", classifyJobUrl("https://jobs.ashbyhq.com/elevenlabs") === null);
check("smartrecruiters drops slug", classifyJobUrl("https://jobs.smartrecruiters.com/Mandiant/743999796548760-cloud-security-architect-remote-denmark-")?.canonical === "https://jobs.smartrecruiters.com/Mandiant/743999796548760");
check("personio", classifyJobUrl("https://checkmk-gmbh.jobs.personio.com/job/2526687?language=en")?.canonical === "https://checkmk-gmbh.jobs.personio.com/job/2526687");
check("teamtailor", classifyJobUrl("https://doconomy.teamtailor.com/jobs/6536300-security-engineer")?.canonical === "https://doconomy.teamtailor.com/jobs/6536300");
check("aggregator rejected: remoterocketship", classifyJobUrl("https://www.remoterocketship.com/country/italy/jobs/cloud-engineer/") === null);
check("aggregator rejected: builtin", classifyJobUrl("https://builtin.com/job/security-engineer/3222367") === null);
check("aggregator rejected: glassdoor", classifyJobUrl("https://www.glassdoor.com/Job/italy-security-engineer-jobs-SRCH.htm") === null);
check("non-http rejected", classifyJobUrl("javascript:alert(1)") === null);
check("canonicalUrl tidies non-ATS", canonicalUrl("https://example.com/a/?utm_source=x&id=5#frag") === "https://example.com/a?id=5");

// ---- evidence-in-text (the sponsorship anti-hallucination check) ----
const posting = "About us. We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate.\nBenefits: 25 days leave.";
check("evidence exact quote passes", evidenceInText("We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate.", posting));
check("evidence with curly apostrophe + case passes", evidenceInText("we do sponsor visas! however, we aren’t able to successfully sponsor visas for every role and every candidate.", posting));
check("evidence with ellipsis pieces passes", evidenceInText("We do sponsor visas! … sponsor visas for every role and every candidate.", posting));
check("fabricated evidence fails", !evidenceInText("We provide full visa sponsorship and relocation support for all hires.", posting));
check("too-short evidence fails", !evidenceInText("visa", posting));
check("empty evidence fails", !evidenceInText("", posting));

// ---- pre-filters ----
const long = (s: string) => s + " ".repeat(10) + "lorem ipsum dolor sit amet ".repeat(30);
check("prefilter: too short", quickReject("italy-remote", "tiny") !== null);
check("prefilter: US-only rejected", quickReject("italy-remote", long("Remote, US. Must be authorized to work in the United States.")) !== null);
check("prefilter: US boilerplate + Europe signal passes", quickReject("italy-remote", long("Remote across Europe. Our US entity requires authorized to work in the United States for US staff.")) === null);
check("prefilter: on-site role with no remote language is rejected", quickReject("italy-remote", long("Hybrid role based in Madrid, three days in the office.")) !== null);
check("prefilter: JSON-LD telecommute counts as remote", quickReject("italy-remote", long("Location type: TELECOMMUTE. Security engineer.")) === null);
check("prefilter: remote boards are exempt from the remote-language check", quickReject("italy-remote", long("Security engineer. Location: Anywhere in the World."), { remoteBoard: true }) === null);
check("prefilter: sponsorship track does not require remote language", quickReject("sponsorship", long("On-site in Berlin. We offer visa sponsorship.")) === null);
check("prefilter: neutral remote passes to the model", quickReject("italy-remote", long("Fully remote security engineer role.")) === null);
check("prefilter: sponsorship track needs sponsorship words", quickReject("sponsorship", long("Great cloud security role in Berlin.")) !== null);
check("prefilter: explicit 'do not sponsor' is rejected", quickReject("sponsorship", long("We do not sponsor visas for this role. Must be authorized to work in the US.")) !== null);
check("prefilter: 'Visa Sponsorship Available: No' is rejected", quickReject("sponsorship", long("Remote. Visa Sponsorship Available: No. Great security role.")) !== null);
check("prefilter: 'unable to consider candidates who require sponsorship' is rejected", quickReject("sponsorship", long("We are unable to consider candidates who require visa sponsorship now or in the future.")) !== null);
check("prefilter: mixed statement (sponsors, but not for every role) still passes", quickReject("sponsorship", long("We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate.")) === null);
check("prefilter: 'Visa Sponsorship Available: Yes' passes", quickReject("sponsorship", long("Relocation and Visa Sponsorship Available: Yes for the right candidate.")) === null);
check("prefilter: denial plus relocation package still passes to the model", quickReject("sponsorship", long("We cannot sponsor work visas. We offer a relocation package within Germany.")) === null);
check("prefilter: sponsorship words present passes", quickReject("sponsorship", long("We offer visa sponsorship and relocation.")) === null);
check("prefilter: africa-remote worldwide remote passes", quickReject("africa-remote", long("Fully remote, worldwide. Security engineer role.")) === null);
check("prefilter: africa-remote Nigeria named passes", quickReject("africa-remote", long("Remote - Nigeria, Ghana, or Kenya. Security engineer role.")) === null);
check("prefilter: africa-remote US-only is rejected", quickReject("africa-remote", long("Remote, US. Must be authorized to work in the United States.")) !== null);
check("prefilter: africa-remote EU-only is rejected", quickReject("africa-remote", long("Remote, EU only. Must be eligible to work in the EU.")) !== null);
check("prefilter: africa-remote UK-only is rejected", quickReject("africa-remote", long("Remote, UK only. Must be authorized to work in the UK.")) !== null);
check("prefilter: africa-remote on-site role is rejected (no remote language)", quickReject("africa-remote", long("Hybrid role based in Lagos, three days in the office.")) !== null);
check("prefilter: uk-remote UK named passes", quickReject("uk-remote", long("Fully remote, UK based. Security engineer role.")) === null);
check("prefilter: uk-remote London named passes", quickReject("uk-remote", long("Remote - London. Security engineer role.")) === null);
check("prefilter: uk-remote with no UK mention is rejected (no worldwide fallback for this track)", quickReject("uk-remote", long("Fully remote, worldwide. Security engineer role.")) !== null);
check("prefilter: uk-remote US-only is rejected", quickReject("uk-remote", long("Remote, US. Must be authorized to work in the United States.")) !== null);
check("prefilter: uk-remote on-site role is rejected (no remote language)", quickReject("uk-remote", long("Hybrid role based in London, three days in the office.")) !== null);
check("prefilter: uk-remote passes even when it requires UK right to work (not a quickReject concern)", quickReject("uk-remote", long("Remote, UK. Must hold existing right to work in the UK; we do not sponsor visas.")) === null);
check("prefilter: italy-hybrid on-site Milan passes (no remote language needed)", quickReject("italy-hybrid", long("Hybrid role based in Milan, three days in the office. Security engineer.")) === null);
check("prefilter: italy-hybrid fully on-site Rome passes", quickReject("italy-hybrid", long("On-site, Rome office five days a week. Security engineer.")) === null);
check("prefilter: italy-hybrid with no Italy mention is rejected", quickReject("italy-hybrid", long("Hybrid role based in Berlin, three days in the office. Security engineer.")) !== null);
check("prefilter: italy-hybrid worldwide-remote with no Italy mention is rejected (strict opt-in)", quickReject("italy-hybrid", long("Fully remote, worldwide. Security engineer role.")) !== null);

// ---- judge ----
const base: ScreenResult = {
  decision: "apply", score: 88, confidence: "high", hard_filter_failures: [], remote_eligibility: "eligible",
  seniority_detected: "senior", matched_requirements: [], gaps: [], one_line_reason: "", tailoring_note: "",
  company: "Acme", title: "Cloud Security Engineer", location: "Remote", salary: "x",
  sponsorship_country: "USA", sponsorship_verified: true,
  sponsorship_evidence: "We do sponsor visas! However, we aren't able to successfully sponsor visas for every role and every candidate.",
};
check("judge italy 88 -> apply", judge("italy-remote", base, posting).decision === "apply");
check("judge italy 60 -> review", judge("italy-remote", { ...base, score: 60 }, posting).decision === "review");
check("judge italy 50 (exact floor) -> review", judge("italy-remote", { ...base, score: 50 }, posting).decision === "review");
check("judge italy 49 -> skip", judge("italy-remote", { ...base, score: 49 }, posting).decision === "skip");
check("judge hard-filter failure forces skip even at score 95", judge("italy-remote", { ...base, score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge italy not_eligible forces skip", judge("italy-remote", { ...base, remote_eligibility: "not_eligible" }, posting).decision === "skip");
check("judge sponsorship verified + 88 -> apply", judge("sponsorship", base, posting).decision === "apply");
check("judge sponsorship 62 -> review", judge("sponsorship", { ...base, score: 62 }, posting).decision === "review");
check("judge sponsorship 50 (exact floor) -> review", judge("sponsorship", { ...base, score: 50 }, posting).decision === "review");
check("judge sponsorship 49 -> skip", judge("sponsorship", { ...base, score: 49 }, posting).decision === "skip");
check("judge sponsorship w/ FABRICATED evidence -> skip", judge("sponsorship", { ...base, sponsorship_evidence: "We sponsor everyone, guaranteed relocation package." }, posting).decision === "skip");
check("judge sponsorship Australia 88 -> apply", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 88 }, posting).decision === "apply");
check("judge sponsorship Australia 80 (exact country floor) -> apply", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 80 }, posting).decision === "apply");
check("judge sponsorship Australia 79 -> skip (no review tier for this country)", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 79 }, posting).decision === "skip");
check("judge sponsorship Australia 62 -> skip (would have qualified on the normal 50 floor)", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 62 }, posting).decision === "skip");
check("judge sponsorship United Kingdom 79 -> skip", judge("sponsorship", { ...base, sponsorship_country: "United Kingdom", score: 79 }, posting).decision === "skip");
check("judge sponsorship Scotland 85 -> apply (Scotland counts as UK)", judge("sponsorship", { ...base, sponsorship_country: "Scotland", score: 85 }, posting).decision === "apply");
check("judge sponsorship Australia hard-filter failure forces skip even at 95", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge sponsorship Australia unverified sponsorship forces skip even at 95", judge("sponsorship", { ...base, sponsorship_country: "Australia", score: 95, sponsorship_verified: false }, posting).decision === "skip");
check("judge sponsorship model says unverified -> skip", judge("sponsorship", { ...base, sponsorship_verified: false }, posting).decision === "skip");
check("judge africa-remote 88 -> apply", judge("africa-remote", base, posting).decision === "apply");
check("judge africa-remote 75 (exact apply-min) -> apply", judge("africa-remote", { ...base, score: 75 }, posting).decision === "apply");
check("judge africa-remote 74 -> review (floor lowered to 50 on 2026-10-04)", judge("africa-remote", { ...base, score: 74 }, posting).decision === "review");
check("judge africa-remote 60 -> review (same floor as the other tracks now)", judge("africa-remote", { ...base, score: 60 }, posting).decision === "review");
check("judge africa-remote 50 (exact floor) -> review", judge("africa-remote", { ...base, score: 50 }, posting).decision === "review");
check("judge africa-remote 49 -> skip", judge("africa-remote", { ...base, score: 49 }, posting).decision === "skip");
check("judge africa-remote hard-filter failure forces skip even at score 95", judge("africa-remote", { ...base, score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge africa-remote not_eligible forces skip", judge("africa-remote", { ...base, remote_eligibility: "not_eligible" }, posting).decision === "skip");
check("judge uk-remote 88 -> apply", judge("uk-remote", base, posting).decision === "apply");
check("judge uk-remote 60 -> review (same floor as italy-remote)", judge("uk-remote", { ...base, score: 60 }, posting).decision === "review");
check("judge uk-remote 50 (exact floor) -> review", judge("uk-remote", { ...base, score: 50 }, posting).decision === "review");
check("judge uk-remote 49 -> skip", judge("uk-remote", { ...base, score: 49 }, posting).decision === "skip");
check("judge uk-remote hard-filter failure forces skip even at score 95", judge("uk-remote", { ...base, score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge uk-remote not_eligible forces skip", judge("uk-remote", { ...base, remote_eligibility: "not_eligible" }, posting).decision === "skip");
check("judge italy-hybrid 88 -> apply", judge("italy-hybrid", { ...base, location: "Milan, Italy (Hybrid)" }, posting).decision === "apply");
check("judge italy-hybrid 60 -> review", judge("italy-hybrid", { ...base, score: 60, location: "Milan, Italy (Hybrid)" }, posting).decision === "review");
check("judge italy-hybrid 50 (exact floor) -> review", judge("italy-hybrid", { ...base, score: 50, location: "Milan, Italy (Hybrid)" }, posting).decision === "review");
check("judge italy-hybrid 49 -> skip", judge("italy-hybrid", { ...base, score: 49, location: "Milan, Italy (Hybrid)" }, posting).decision === "skip");
check("judge italy-hybrid hard-filter failure forces skip even at score 95", judge("italy-hybrid", { ...base, score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge italy-hybrid not_eligible forces skip", judge("italy-hybrid", { ...base, remote_eligibility: "not_eligible" }, posting).decision === "skip");

// ---- the wider set of job systems ----
check("workable", classifyJobUrl("https://apply.workable.com/gatekeeper-3/j/D74033B7A8/")?.canonical === "https://apply.workable.com/gatekeeper-3/j/D74033B7A8");
check("workday strips locale + /apply", classifyJobUrl("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Italy-Milan/Senior-Cloud-Security-Engineer_JR2001234/apply/autofillWithResume")?.meta?.rest === "Italy-Milan/Senior-Cloud-Security-Engineer_JR2001234");
check("workday builds tenant/site", (() => { const i = classifyJobUrl("https://acme.wd3.myworkdayjobs.com/Careers/job/Remote/SRE_R-123"); return i?.company === "acme" && i?.meta?.site === "Careers"; })());
check("breezy drops slug", classifyJobUrl("https://acme.breezy.hr/p/0123456789ab-security-engineer")?.canonical === "https://acme.breezy.hr/p/0123456789ab");
check("jazzhr", classifyJobUrl("https://acme.applytojob.com/apply/AbC123xyz/Security-Engineer?source=x")?.canonical === "https://acme.applytojob.com/apply/AbC123xyz");
check("join.com", classifyJobUrl("https://join.com/companies/acme/12345678-cloud-engineer")?.canonical === "https://join.com/companies/acme/12345678");
check("jobvite", classifyJobUrl("https://jobs.jobvite.com/acme/job/oAbCd123")?.canonical === "https://jobs.jobvite.com/acme/job/oAbCd123");
check("rippling", classifyJobUrl("https://ats.rippling.com/acme/jobs/9c046f9e-38a7-4f84-a045-e3d9cf3a3c27")?.canonical === "https://ats.rippling.com/acme/jobs/9c046f9e-38a7-4f84-a045-e3d9cf3a3c27");
check("recruitee company index rejected", classifyJobUrl("https://acme.recruitee.com/") === null);
check("workday board index rejected", classifyJobUrl("https://acme.wd3.myworkdayjobs.com/Careers") === null);
check("linkedin is never a job source", classifyJobUrl("https://www.linkedin.com/jobs/view/1234567890") === null);
check("board listing URL is not an ATS page", classifyJobUrl("https://remoteok.com/remote-jobs/remote-security-engineer-acme-1234") === null);

// ---- LinkedIn leads: parsing, and refusing loose matches ----
const P = (t: string) => parseLinkedInTitle(t);
check("lead: 'X hiring Role - Remote in EMEA'", eq(P("Pencil hiring Security Engineer - Remote in EMEA"), { company: "Pencil", role: "Security Engineer - Remote" }));
check("lead: 'Role at Company'", P("Senior Security Engineer - Remote EMEA at Aircall")?.company === "Aircall");
check("lead: 'Role (loc) - Company'", P("Senior Security Engineer (Europe, Remote) - Intel 471")?.company === "Intel 471");
check("lead: italian 'sta assumendo'", eq(P("NEVERHACK Italy sta assumendo Cybersecurity GRC Engineer in Napoli"), { company: "NEVERHACK Italy", role: "Cybersecurity GRC Engineer" }));
check("lead: region-only suffix gives no company", P("Security Software Specialist (Remote) - EMEA")?.company === "");
check("lead: trailing job attribute is not a company", P("Senior Platform Engineer - Azure, Terraform, Kubernetes - fully remote - contract or permanent")?.company === "");
check("lead: 'Company hiring Role in Place | LinkedIn'", eq(P("Zoom hiring Cloud Operations Engineer- Kubernetes in United States | LinkedIn"), { company: "Zoom", role: "Cloud Operations Engineer- Kubernetes" }));
check("lead: list-page titles yield no company", P("28,000+ Platform Engineer jobs in United States")?.company === "");
check("lead: named recruiters are not employers", !isResolvable({ role: "DevOps/AWS Platform Engineer", company: "Robert Half" }) && !isResolvable({ role: "Cloud Engineer", company: "Acme Recruitment Ltd" }));
check("lead: a real employer is resolvable", isResolvable({ role: "Cloud Security Engineer", company: "Hudson River Trading" }));
check("lead: recruiter reposts are not employers", !isResolvable({ role: "Product Security Engineer", company: "Hire Feed" }) && !isResolvable({ role: "DevOps Engineer", company: "Hired" }));
check("lead: searchableRole trims location tails", searchableRole("Senior Application Security Engineer (Remote, EMEA or Americas, EST)") === "Senior Application Security Engineer");
check("role match: same role", roleMatches("Senior Application Security Engineer", "Senior Application Security Engineer at Grafana Labs"));
check("role match: different role from the same company is refused", !roleMatches("Senior Application Security Engineer", "Senior Developer Advocate at Grafana Labs"));
check("role match: generic 'Support Engineer' vs security role refused", !roleMatches("Cloud Security Engineer", "Technical Support Engineer - Grafana Labs"));
check("company match: slug", companyMatches("Grafana Labs", "grafanalabs", ""));
check("company match: workable slug suffix", companyMatches("Gatekeeper", "gatekeeper-3", ""));
check("company match: unrelated company refused", !companyMatches("Pencil", "acme", "Security Engineer at Acme"));

// ---- generic board leads (Indeed/InfoJobs/Subito): parsing ----
check("board lead: pipe-delimited 'Role | Company | Location'", eq(parseBoardTitle("Security Engineer | Acme Corp | Milano"), { role: "Security Engineer", company: "Acme Corp" }));
check("board lead: pipe-delimited rejects a work-mode as the company", parseBoardTitle("Security Engineer | Remote | Milano")?.company === "");
check("board lead: Italian 'Role a Location presso Company'", eq(parseBoardTitle("Addetto alle vendite a Milano presso Esselunga"), { role: "Addetto alle vendite", company: "Esselunga" }));
check("board lead: falls back to the dash/at patterns for a plain title", parseBoardTitle("Senior Security Engineer - Remote EMEA at Aircall")?.company === "Aircall");
check("board lead: too short returns null", parseBoardTitle("Job") === null);
check("company match: via the hit's own text", companyMatches("Aircall", "opaque-slug-9", "Senior Security Engineer at Aircall | Lever"));

// ---- title triage / ranking ----
check("triage: keeps security roles", titleTriage("Senior Cloud Security Engineer") === null);
check("triage: keeps SRE / DevOps / network", titleTriage("Site Reliability Engineer") === null && titleTriage("DevOps Engineer (AWS)") === null && titleTriage("Network Security Engineer - Fortinet") === null);
check("triage: drops sales even with a security word", titleTriage("Senior Sales Manager - GRC Europe") !== null && titleTriage("Security Sales Engineer") !== null);
check("triage: drops pre-sales / field / management titles", ["Cloud Solutions Architect - Alliances", "Cloud Field Engineer", "Cloud Engineering Manager", "Cloud Professional Services Manager", "Security Solutions Engineer"].every((x) => titleTriage(x) !== null));
check("triage: keeps security manager roles (rank penalty only)", titleTriage("Security Operations Manager") === null && hintRank("Security Operations Manager") < hintRank("Security Operations Engineer"));
check("triage: drops SAP GRC consulting", titleTriage("SAP GRC Consultant") !== null);
check("triage: drops off-target engineering", titleTriage("Senior Frontend Engineer, Platform") !== null);
check("triage: keeps a security-flavoured full-stack title", titleTriage("Full Stack Security Engineer") === null);
check("triage: title with no role can be rescued by the snippet", titleTriage("Acme Jobs", "Security Engineer, remote in Europe") === null);
check("triage: title with no role and no context dropped", titleTriage("Acme Jobs", "Join our team") !== null);
check("rank: junior DevOps is not penalised (the candidate wants junior/mid DevOps)", hintRank("Junior DevOps Engineer (Europe)") >= hintRank("DevOps Engineer (Europe)"));
check("freshness: recent > unknown > old", freshnessRank(30) > freshnessRank(null) && freshnessRank(null) > freshnessRank(400) && freshnessRank(150) > freshnessRank(400));
check("rank: EMEA security beats US-only devops", hintRank("Senior Security Engineer (EMEA, Remote)") > hintRank("DevOps Engineer - United States"));

// ---- query rotation spreads across the list and covers all of it ----
const list = Array.from({ length: 140 }, (_, i) => `q${i}`);
check("rotation: no repeats within a run", new Set(pickQueries(list, 7, 5)).size === 5);
check("rotation: 28 runs cover all 140 queries", (() => { const s = new Set<string>(); for (let r = 0; r < 28; r++) pickQueries(list, r, 5).forEach((q) => s.add(q)); return s.size === 140; })());
check("rotation: one run spans several roles (14 platforms per role)", new Set(pickQueries(list, 3, 5).map((q) => Math.floor(Number(q.slice(1)) / 14))).size >= 4);
check("rotation: short list", pickQueries(["a", "b"], 5, 6).length === 2);

// ---- company-board crawl: scope + location eligibility (decided from the list alone) ----
const J = (title: string, location: string, remote: boolean | null = null): BoardJob => ({ url: "https://x/1", title, location, remote, postedAt: null });
check("crawl/italy: plain 'Remote' is eligible", italyEligibility(J("Senior Cloud Security Engineer", "Remote", true)) === null);
check("crawl/italy: 'Remote - EMEA' is eligible", italyEligibility(J("Security Engineer", "Remote - EMEA")) === null);
check("crawl/italy: remote in Italy is eligible", italyEligibility(J("DevSecOps Engineer", "Italy", true)) === null);
check("crawl/italy: a list of specific other countries is rejected", italyEligibility(J("SRE", "Berlin Office / Norway / Netherlands / Portugal", true)) !== null);
check("crawl/italy: 'Remote - Poland' is rejected (Poland-based only)", italyEligibility(J("Security Engineer", "Remote - Poland", true)) !== null);
check("crawl/italy: Israel / Poland / UK list is rejected", italyEligibility(J("Security Engineer", "Remote, Israel / Remote, Poland / Remote, United Kingdom", true)) !== null);
check("crawl/italy: country list that includes Italy is eligible", italyEligibility(J("Security Engineer", "Remote - Italy / Remote - Spain", true)) === null);
check("crawl/italy: Milan-based remote role is eligible", italyEligibility(J("Cyber Security Governance Specialist", "Milan", true)) === null);
check("crawl/italy: on-site is rejected", italyEligibility(J("Security Engineer", "Milan, Italy", false)) !== null);
check("crawl/italy: hybrid (Ashby) is rejected", italyEligibility(J("Security Engineer", "Hybrid - Munich", false)) !== null);
check("crawl/italy: no remote signal at all is rejected", italyEligibility(J("Security Engineer", "Madrid, Spain")) !== null);
check("crawl/italy: remote tied to Tokyo is rejected", italyEligibility(J("Security Engineer", "Tokyo", true)) !== null);
check("crawl/italy: 'Remote - US' is rejected", italyEligibility(J("Security Engineer", "Remote - US")) !== null);
check("crawl/italy: 'Israel (Remote)' is rejected", italyEligibility(J("Security Engineer", "Israel (Remote)")) !== null);
check("crawl/italy: UK-only remote is rejected", italyEligibility(J("Security Engineer", "Remote - London, UK", true)) !== null);
check("crawl/italy: UK + Europe remote is eligible", italyEligibility(J("Security Engineer", "London / Remote Europe", true)) === null);
check("crawl/italy: remote flagged in the title counts", italyEligibility(J("Cloud Engineer (Remote)", "")) === null);
check("crawl/africa: plain 'Remote' is eligible", africaEligibility(J("Security Engineer", "Remote", true)) === null);
check("crawl/africa: Nigeria named is eligible", africaEligibility(J("Security Engineer", "Remote - Nigeria", true)) === null);
check("crawl/africa: worldwide is eligible", africaEligibility(J("Security Engineer", "Remote - Worldwide", true)) === null);
check("crawl/africa: Lagos-based remote role is eligible", africaEligibility(J("Security Engineer", "Lagos", true)) === null);
check("crawl/africa: a list of specific other countries is rejected", africaEligibility(J("SRE", "Berlin Office / Norway / Netherlands / Portugal", true)) !== null);
check("crawl/africa: 'Remote - Poland' is rejected (Poland-based only)", africaEligibility(J("Security Engineer", "Remote - Poland", true)) !== null);
check("crawl/africa: on-site is rejected", africaEligibility(J("Security Engineer", "Lagos, Nigeria", false)) !== null);
check("crawl/africa: no remote signal at all is rejected", africaEligibility(J("Security Engineer", "Madrid, Spain")) !== null);
check("crawl/africa: remote tied to Tokyo is rejected", africaEligibility(J("Security Engineer", "Tokyo", true)) !== null);
check("crawl/scope: africa-remote uses africaEligibility", inScope("africa-remote", J("Senior Cloud Security Engineer", "Remote - Poland", true)) !== null && inScope("africa-remote", J("Senior Cloud Security Engineer", "Remote - Nigeria", true)) === null);
check("crawl/uk: UK named is eligible", ukEligibility(J("Security Engineer", "Remote - UK", true)) === null);
check("crawl/uk: London-based remote is eligible", ukEligibility(J("Security Engineer", "London", true)) === null);
check("crawl/uk: 'United Kingdom' full name is eligible", ukEligibility(J("Security Engineer", "Remote, United Kingdom", true)) === null);
check("crawl/uk: bare 'Remote' with no UK mention is rejected (strict opt-in, unlike italy/africa)", ukEligibility(J("Security Engineer", "Remote", true)) !== null);
check("crawl/uk: worldwide with no UK mention is rejected", ukEligibility(J("Security Engineer", "Remote - Worldwide", true)) !== null);
check("crawl/uk: on-site in London is rejected", ukEligibility(J("Security Engineer", "London, UK", false)) !== null);
check("crawl/uk: UK named in the title counts", ukEligibility(J("Security Engineer (UK Remote)", "")) === null);
check("crawl/scope: uk-remote uses ukEligibility", inScope("uk-remote", J("Senior Cloud Security Engineer", "Remote", true)) !== null && inScope("uk-remote", J("Senior Cloud Security Engineer", "Remote - UK", true)) === null);
check("crawl/italy-hybrid: Milan on-site is eligible (remote-ness doesn't matter)", italyHybridEligibility(J("Security Engineer", "Milan, Italy", false)) === null);
check("crawl/italy-hybrid: Rome hybrid is eligible", italyHybridEligibility(J("Security Engineer", "Rome (Hybrid)", null)) === null);
check("crawl/italy-hybrid: bare 'Remote' with no Italy mention is rejected (strict opt-in)", italyHybridEligibility(J("Security Engineer", "Remote", true)) !== null);
check("crawl/italy-hybrid: Berlin on-site is rejected (not Italy)", italyHybridEligibility(J("Security Engineer", "Berlin, Germany", false)) !== null);
check("crawl/italy-hybrid: Italy named in the title counts", italyHybridEligibility(J("Security Engineer (Milan, Hybrid)", "")) === null);
check("crawl/scope: italy-hybrid uses italyHybridEligibility", inScope("italy-hybrid", J("Senior Cloud Security Engineer", "Berlin", false)) !== null && inScope("italy-hybrid", J("Senior Cloud Security Engineer", "Milan", false)) === null);
check("crawl/sponsorship: on-site Germany is fine", sponsorshipEligibility(J("Security Engineer", "Berlin, Germany", false)) === null);
check("crawl/sponsorship: US city with state code is fine", sponsorshipEligibility(J("Security Engineer", "Austin, TX")) === null);
check("crawl/sponsorship: India is outside the target countries", sponsorshipEligibility(J("Security Engineer", "Bengaluru, India")) !== null);
check("crawl/sponsorship: India + Canada listing is kept", sponsorshipEligibility(J("Security Engineer", "Bengaluru, India / Toronto, Canada")) === null);
check("crawl/scope: target role passes", inScope("italy-remote", J("Senior Cloud Security Engineer", "Remote", true)) === null);
check("crawl/scope: generic software engineer is out", inScope("italy-remote", J("Senior Software Engineer, Platform", "Remote", true)) !== null);
check("crawl/scope: sales role is out even when remote", inScope("italy-remote", J("Security Sales Engineer", "Remote", true)) !== null);
check("crawl/scope: Cloudflare-the-company and Cloud Commerce are not cloud roles", inScope("italy-remote", J("Senior Cloudflare One GTM Specialist", "Remote", true)) !== null && inScope("italy-remote", J("Business Analyst – Cloud Commerce & SaaS", "Remote", true)) !== null);
check("crawl/scope: real cloud roles are in", ["Cloud Engineer", "Senior Cloud Architect", "Cloud Operations Specialist", "Multi-Cloud DevOps Engineer"].every((x) => inScope("italy-remote", J(x, "Remote", true)) === null));
check("crawl/scope: physical security / EHS are out", ["Physical Security Manager", "Security Guard", "EHS Compliance Analyst", "Health & Safety Officer"].every((x) => inScope("italy-remote", J(x, "Remote", true)) !== null));
check("crawl/scope: finance audit is out", inScope("italy-remote", J("Internal Audit Manager", "Remote", true)) !== null);
check("crawl/scope: IT audit / GRC is in", inScope("italy-remote", J("IT Risk & Compliance Analyst", "Remote", true)) === null && inScope("italy-remote", J("GRC Engineer", "Remote", true)) === null);
check("crawl/scope: DevOps / SRE / sysadmin / network are in", ["DevOps Engineer", "Site Reliability Engineer", "Systems Administrator", "Network Engineer (Fortinet)"].every((x) => inScope("italy-remote", J(x, "Remote", true)) === null));

// ---- html -> text ----
check("greenhouse entity-escaped html", eq(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;").includes("Hello & welcome"), true));
check("hex numeric entities decode (HN comments)", htmlToText("LiveKit| http:&#x2F;&#x2F;livekit.io&#x2F; | Remote") === "LiveKit| http://livekit.io/ | Remote");
check("plain html lists", htmlToText("<p>Intro</p><ul><li>A</li><li>B</li></ul>").includes("• A"));
check("scripts stripped", !htmlToText("<p>ok</p><script>alert(1)</script>").includes("alert"));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
