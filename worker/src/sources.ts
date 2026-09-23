// Discovery (Brave Search) and verification (direct fetch against ATS APIs,
// or generic HTML text extraction) for job postings.

export interface SearchHit {
  title: string;
  url: string;
}

export async function braveSearch(apiKey: string, query: string, count = 10): Promise<SearchHit[]> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
  );
  if (!res.ok) {
    console.error(`Brave Search error ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = (await res.json()) as any;
  const results = data?.web?.results ?? [];
  return results.map((r: any) => ({ title: r.title as string, url: r.url as string }));
}

/**
 * Fetch a posting's raw text for screening, preferring a known ATS JSON API
 * (reliable, structured) and falling back to generic HTML text extraction.
 * Returns null if the posting could not be verified live this run —
 * callers must never screen from a search snippet alone.
 */
export async function fetchPostingText(url: string): Promise<string | null> {
  try {
    const known = await fetchKnownAts(url);
    if (known) return known;
    return await fetchGenericHtml(url);
  } catch (err) {
    console.error(`fetchPostingText failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

async function fetchKnownAts(url: string): Promise<string | null> {
  // Greenhouse: job-boards.greenhouse.io/<company>/jobs/<id> -> boards-api JSON
  let m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)(?:&token=(\d+))?\/?(?:jobs\/(\d+))?/);
  if (m) {
    const company = m[1];
    const id = m[3] || m[2];
    if (id) {
      const api = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${id}`;
      const j = await fetchJson(api);
      if (j) return `${j.title}\n${j.location?.name ?? ""}\n\n${stripHtml(j.content ?? "")}`;
    }
  }
  // Lever: jobs.lever.co/<company>/<uuid> -> api.lever.co JSON
  m = url.match(/jobs\.lever\.co\/([\w-]+)\/([\w-]+)/);
  if (m) {
    const api = `https://api.lever.co/v0/postings/${m[1]}/${m[2]}`;
    const j = await fetchJson(api);
    if (j) return `${j.text}\n${j.categories?.location ?? ""}\n\n${stripHtml(j.descriptionPlain ?? j.description ?? "")}\n\n${stripHtml((j.lists ?? []).map((l: any) => `${l.text}\n${stripHtml(l.content ?? "")}`).join("\n"))}`;
  }
  // Ashby: jobs.ashbyhq.com/<company>/<uuid> -> posting-api JSON
  m = url.match(/jobs\.ashbyhq\.com\/([\w-]+)\/([\w-]+)/);
  if (m) {
    const api = `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`;
    const j = await fetchJson(api);
    const posting = j?.jobs?.find((p: any) => p.id === m![2] || p.jobUrl?.includes(m![2]));
    if (posting) return `${posting.title}\n${posting.location ?? ""}\n\n${stripHtml(posting.descriptionHtml ?? posting.descriptionPlain ?? "")}`;
  }
  // SmartRecruiters: jobs.smartrecruiters.com/<company>/<postingId>-...
  m = url.match(/jobs\.smartrecruiters\.com\/([\w-]+)\/(\d+)/);
  if (m) {
    const api = `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`;
    const j = await fetchJson(api);
    if (j) return `${j.name}\n${JSON.stringify(j.location ?? {})}\n\n${stripHtml(j.jobAd?.sections?.jobDescription?.text ?? "")}\n\n${stripHtml(j.jobAd?.sections?.qualifications?.text ?? "")}`;
  }
  return null;
}

async function fetchJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  return res.json();
}

/** Generic fallback: fetch HTML and strip it down to visible text via HTMLRewriter. */
async function fetchGenericHtml(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobbermanBot/1.0)" } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("html")) return null;

  const chunks: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, svg", {
      element(el) {
        el.remove();
      },
    })
    .on("body *", {
      text(t) {
        chunks.push(t.text);
      },
    });
  const transformed = rewriter.transform(res);
  await transformed.arrayBuffer(); // drain the stream to run the handlers
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? text : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
