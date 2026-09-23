// Validates the exact request body the Worker sends to Claude, via the token-counting
// endpoint (validates model, system, tools and tool_choice without spending credits).
//   ANTHROPIC_API_KEY=... npx esbuild scripts/validate-request.ts --bundle --platform=node --format=esm --outfile=.tmp/vr.mjs && node .tmp/vr.mjs
import { MODEL, SCREEN_TOOL, SYSTEM_PREFIX } from "../src/claude";
import { CANDIDATE_PROFILE } from "../src/profile";

const body = {
  model: MODEL,
  system: [{ type: "text", text: SYSTEM_PREFIX + CANDIDATE_PROFILE, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Track: italy-remote\nToday: 2026-09-24\nSource URL: https://example.com/job\n\n--- POSTING TEXT ---\nSenior Cloud Security Engineer, remote in Europe.\n--- END POSTING TEXT ---" }],
  tools: [SCREEN_TOOL],
  tool_choice: { type: "tool", name: "record_screening" },
};
const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});
console.log("HTTP", res.status);
console.log((await res.text()).slice(0, 400));
