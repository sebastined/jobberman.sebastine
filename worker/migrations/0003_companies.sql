-- Company job-board crawl: the companies the pipeline learns about and recrawls.
--   wrangler d1 execute jobberman --remote --file=./migrations/0003_companies.sql
-- (schema.sql already contains this for fresh databases.) The table is seeded automatically on the next run
-- from the job URLs already in `seen`.

CREATE TABLE IF NOT EXISTS companies (
  key           TEXT PRIMARY KEY,
  ats           TEXT NOT NULL,
  slug          TEXT NOT NULL,
  eu            INTEGER NOT NULL DEFAULT 0,
  hits          INTEGER NOT NULL DEFAULT 0,       -- times it appeared in search results (more mentions = more likely to have relevant roles)
  sponsors      INTEGER NOT NULL DEFAULT 0,       -- 1 = surfaced by a sponsorship search, or one of its postings mentions sponsorship
  first_seen    TEXT NOT NULL,
  last_crawled  TEXT,
  open_roles    INTEGER NOT NULL DEFAULT 0,
  added         INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_companies_crawl ON companies(fail_count, last_crawled);
