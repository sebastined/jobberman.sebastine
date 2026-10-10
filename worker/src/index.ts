import type { Track } from "./types";
import { handleApi } from "./api";
import { isAuthorized } from "./auth";
import { errorMessage, logError, logInfo } from "./log";
import { runPipeline } from "./pipeline";

const NO_STORE = { "cache-control": "no-store" };

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);

    // Only /api/* is routed to the Worker (`assets.run_worker_first`); the UI's static files are served straight from
    // the asset store. Anything else that lands here is answered from the assets too, so a routing change can't break the UI.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    try {
      if (!(await isAuthorized(req, env))) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } });
      }
      return await handleApi(req, env, ctx, url);
    } catch (err) {
      logError("api_error", { method: req.method, path: url.pathname, error: errorMessage(err) });
      return Response.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
    }
  },

  // Five crons share this handler, one per minute: :00 screens the Italy-remote track, :15 africa-remote, :30
  // sponsorship, :45 uk-remote, :50 italy-hybrid. Splitting them keeps each invocation inside the free plan's
  // subrequest limit (and uses all 5 of the free plan's cron-trigger slots — none spare).
  //
  // The :50 slot additionally fires on Sat/Sun (wrangler.jsonc: "* * *" instead of "* * 1-5" for that one
  // trigger) — weekends are otherwise fully idle (cron is Mon-Fri everywhere else), so that idle time runs a
  // "deep catchup" pass instead of italy-hybrid: crawl-only, deepest-stale-company-first, screened with
  // DeepSeek (src/deepseek.ts) instead of Claude since it's cheap enough to clear a much bigger backlog with.
  // Rotates across all 5 tracks over the 8 weekend firings so every track's crawl pool gets extra attention,
  // not just one. Added 2026-10-10 after Superhuman Platform Inc (a confirmed sponsorship-relevant company)
  // sat uncrawled for 6+ days — see commit message / SPEC notes for the full diagnosis.
  // The run is awaited (not waitUntil'd) so a failure shows up as a failed invocation instead of a silent success.
  async scheduled(controller, env): Promise<void> {
    const MINUTE_TRACK: Record<string, Track> = { "0": "italy-remote", "15": "africa-remote", "30": "sponsorship", "45": "uk-remote", "50": "italy-hybrid" };
    const minute = controller.cron.match(/^(\d+)\s/)?.[1] ?? "0";
    const scheduled = new Date(controller.scheduledTime);
    const day = scheduled.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const isWeekend = minute === "50" && (day === 0 || day === 6);

    let track: Track;
    let catchup = false;
    if (isWeekend) {
      const CATCHUP_TRACKS: Track[] = ["italy-remote", "sponsorship", "africa-remote", "uk-remote", "italy-hybrid"];
      const HOUR_SLOT: Record<number, number> = { 6: 0, 7: 1, 19: 2, 20: 3 };
      const slot = (day === 6 ? 0 : 4) + (HOUR_SLOT[scheduled.getUTCHours()] ?? 0);
      track = CATCHUP_TRACKS[slot % CATCHUP_TRACKS.length];
      catchup = true;
    } else {
      track = MINUTE_TRACK[minute] ?? "italy-remote";
    }

    try {
      const summary = await runPipeline(env, { tracks: [track], catchup });
      logInfo("cron_run", { cron: controller.cron, track, catchup, ...summary });
    } catch (err) {
      logError("cron_failed", { cron: controller.cron, track, catchup, error: errorMessage(err) });
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
