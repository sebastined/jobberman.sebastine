// Local stand-in for the Anthropic Messages API, used only to exercise the pipeline
// end to end without spending credits. It is deliberately dumb: it "screens" by
// keyword and, on the sponsorship track, quotes the first sentence containing
// "sponsor"/"visa"/"relocat" verbatim from the posting text it was sent.
//   node scripts/mock-anthropic.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] || 8799);
let calls = 0;

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    const payload = JSON.parse(body || "{}");
    const user = payload.messages?.[0]?.content ?? "";
    const track = /Track: (\S+)/.exec(user)?.[1] ?? "italy-remote";
    const url = /Source URL: (\S+)/.exec(user)?.[1] ?? "";
    const text = user.split("--- POSTING TEXT")[1]?.split("--- END POSTING TEXT")[0] ?? "";
    const title = (text.split("\n").map((l) => l.trim()).find((l) => l.length > 3 && !l.startsWith("(")) ?? "Untitled").slice(0, 90);
    const europe = /\b(italy|europe|emea|worldwide|anywhere)\b/i.test(text);
    const sentence = (text.replace(/\s+/g, " ").match(/[^.!?]*\b(sponsor\w*|visa|relocat\w*)\b[^.!?]*[.!?]?/i) || [""])[0].trim();

    const italyScore = europe ? 78 : 41;
    const score = track === "sponsorship" ? (sentence ? 72 : 30) : italyScore;
    const result = {
      decision: score >= 75 ? "apply" : score >= 55 ? "review" : "skip",
      score,
      confidence: "medium",
      hard_filter_failures: score < 55 ? ["mock: no Europe/Italy eligibility found"] : [],
      remote_eligibility: europe ? "eligible" : "unclear",
      seniority_detected: "senior (mock)",
      matched_requirements: ["mock: cloud security overlap"],
      gaps: ["mock screening — not a real assessment"],
      one_line_reason: `MOCK verdict for ${url}`,
      tailoring_note: "MOCK tailoring note.",
      company: new URL(url || "https://unknown.example/x").pathname.split("/")[1] || "unknown",
      title,
      location: europe ? "Remote — Europe (mock)" : "unclear",
      salary: "unclear — not listed",
      sponsorship_country: track === "sponsorship" ? "Germany" : "",
      sponsorship_verified: track === "sponsorship" && !!sentence,
      sponsorship_evidence: track === "sponsorship" ? sentence : "",
    };
    // A fabricated quote every 4th sponsorship call, to prove the code-level check rejects it.
    if (track === "sponsorship" && calls % 4 === 0) result.sponsorship_evidence = "We guarantee full visa sponsorship and relocation for every hire worldwide.";

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", content: [{ type: "tool_use", id: "tu_mock", name: "record_screening", input: result }] }));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock anthropic listening on http://127.0.0.1:${port}`));
