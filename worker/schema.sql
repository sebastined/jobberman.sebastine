-- Jobberman tracker schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS postings (
  id                    TEXT PRIMARY KEY,
  company               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  track                 TEXT NOT NULL DEFAULT 'italy-remote', -- 'italy-remote' | 'sponsorship'
  location              TEXT,
  source_url            TEXT NOT NULL,
  salary                TEXT,
  score                 INTEGER NOT NULL DEFAULT 0,
  decision              TEXT NOT NULL,                        -- 'apply' | 'review' | 'skip'
  confidence            TEXT,                                  -- 'high' | 'medium' | 'low'
  remote_eligibility    TEXT,
  seniority_detected    TEXT,
  matched_requirements  TEXT,                                  -- JSON array, stored as text
  gaps                  TEXT,                                  -- JSON array, stored as text
  one_line_reason       TEXT,
  tailored_summary      TEXT,
  sponsorship_country   TEXT,
  sponsorship_verified  INTEGER NOT NULL DEFAULT 0,             -- 0/1
  sponsorship_evidence  TEXT,
  status                TEXT NOT NULL DEFAULT 'Pending Review', -- Pending Review | Approved to Apply | Applied | Interview | Rejected | Not Pursuing
  status_changed_at     TEXT,
  date_found            TEXT NOT NULL,
  tailored_cv_url       TEXT,
  tailored_cv_filename  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_postings_status ON postings(status);
CREATE INDEX IF NOT EXISTS idx_postings_track ON postings(track);
CREATE INDEX IF NOT EXISTS idx_postings_date_found ON postings(date_found);
CREATE INDEX IF NOT EXISTS idx_postings_source_url ON postings(source_url);

-- Every posting evaluated, regardless of outcome — dedup + audit trail across runs.
CREATE TABLE IF NOT EXISTS seen (
  id              TEXT PRIMARY KEY,
  date_evaluated  TEXT NOT NULL,
  decision        TEXT NOT NULL,
  score           INTEGER NOT NULL DEFAULT 0,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_source_url ON seen(source_url);

-- One row per cron fire, for diagnosing "why no new jobs" without digging through logs.
CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status             TEXT NOT NULL DEFAULT 'running', -- running | ok | error
  postings_added    INTEGER NOT NULL DEFAULT 0,
  postings_evaluated INTEGER NOT NULL DEFAULT 0,
  notes             TEXT
);
