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

  // Two crons share this handler: minute :00 screens the Italy-remote track, :30 the sponsorship track.
  // Splitting them keeps each invocation inside the free plan's subrequest limit. The run is awaited (not
  // waitUntil'd) so a failure shows up as a failed invocation instead of a silent success.
  async scheduled(controller, env): Promise<void> {
    const track: Track = /^30\s/.test(controller.cron) ? "sponsorship" : "italy-remote";
    try {
      const summary = await runPipeline(env, { tracks: [track] });
      logInfo("cron_run", { cron: controller.cron, track, ...summary });
    } catch (err) {
      logError("cron_failed", { cron: controller.cron, track, error: errorMessage(err) });
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
