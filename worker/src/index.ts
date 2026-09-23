import type { Env as BaseEnv, Track } from "./types";
import { handleApi } from "./api";
import { isAuthorized } from "./auth";
import { runPipeline } from "./pipeline";

interface Env extends BaseEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      if (!(await isAuthorized(req, env))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": "Bearer", "cache-control": "no-store" },
        });
      }
      return handleApi(req, env, ctx, url);
    }

    return env.ASSETS.fetch(req);
  },

  // Two crons share this handler: minute :00 screens the Italy-remote track, :30 the sponsorship track.
  // Splitting them keeps each invocation inside the free plan's subrequest limit.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const track: Track = /^30\s/.test(event.cron) ? "sponsorship" : "italy-remote";
    ctx.waitUntil(runPipeline(env, { tracks: [track] }).then((s) => console.log(`cron ${event.cron}:`, JSON.stringify(s))).catch((err) => console.error("Pipeline failed:", err)));
  },
};
