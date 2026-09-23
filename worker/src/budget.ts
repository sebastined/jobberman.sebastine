// Cloudflare's Workers Free plan caps external subrequests at 50 per invocation.
// The first production run of this pipeline died on that limit, so every fetch()
// (Brave, ATS pages, Claude) is now metered against an explicit budget and the
// run stops cleanly with a note instead of crashing mid-way.
export class Budget {
  used = 0;
  constructor(readonly max: number) {}
  get left(): number {
    return this.max - this.used;
  }
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
}

/** Thrown for failures that make continuing pointless (bad key, no credit, rate limited). */
export class FatalApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalApiError";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
