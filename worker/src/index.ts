import type { Env as PipelineEnv } from "./types";
import { handleApi } from "./api";
import { runPipeline } from "./pipeline";

interface Env extends PipelineEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env, url);
    }

    // Manual trigger for testing/on-demand runs: GET /run (no auth — fine for
    // a private workers.dev URL only the owner knows; add a shared-secret
    // check here before making this domain public).
    if (url.pathname === "/run") {
      const summary = await runPipeline(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env).catch((err) => console.error("Pipeline failed:", err)));
  },
};
