// Self-test for the pure logic that guards what reaches the tracker.
//   npx esbuild scripts/selftest.ts --bundle --platform=node --format=esm --outfile=.tmp/selftest.mjs && node .tmp/selftest.mjs
import { canonicalUrl, classifyJobUrl } from "../src/canon";
import { evidenceInText, judge, quickReject } from "../src/rules";
import { htmlToText } from "../src/sources";
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
check("prefilter: neutral remote passes to the model", quickReject("italy-remote", long("Fully remote security engineer role.")) === null);
check("prefilter: sponsorship track needs sponsorship words", quickReject("sponsorship", long("Great cloud security role in Berlin.")) !== null);
check("prefilter: sponsorship words present passes", quickReject("sponsorship", long("We offer visa sponsorship and relocation.")) === null);

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
check("judge italy 50 -> skip", judge("italy-remote", { ...base, score: 50 }, posting).decision === "skip");
check("judge hard-filter failure forces skip even at score 95", judge("italy-remote", { ...base, score: 95, hard_filter_failures: ["requires German"] }, posting).decision === "skip");
check("judge italy not_eligible forces skip", judge("italy-remote", { ...base, remote_eligibility: "not_eligible" }, posting).decision === "skip");
check("judge sponsorship verified + 88 -> apply", judge("sponsorship", base, posting).decision === "apply");
check("judge sponsorship 62 -> review", judge("sponsorship", { ...base, score: 62 }, posting).decision === "review");
check("judge sponsorship 58 -> skip", judge("sponsorship", { ...base, score: 58 }, posting).decision === "skip");
check("judge sponsorship w/ FABRICATED evidence -> skip", judge("sponsorship", { ...base, sponsorship_evidence: "We sponsor everyone, guaranteed relocation package." }, posting).decision === "skip");
check("judge sponsorship model says unverified -> skip", judge("sponsorship", { ...base, sponsorship_verified: false }, posting).decision === "skip");

// ---- html -> text ----
check("greenhouse entity-escaped html", eq(htmlToText("&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;").includes("Hello & welcome"), true));
check("plain html lists", htmlToText("<p>Intro</p><ul><li>A</li><li>B</li></ul>").includes("• A"));
check("scripts stripped", !htmlToText("<p>ok</p><script>alert(1)</script>").includes("alert"));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
