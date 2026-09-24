-- Adds board provenance + persisted run logs. Run once against an existing database:
--   wrangler d1 execute jobberman --remote --file=./migrations/0002_boards.sql
-- (schema.sql already contains these columns for fresh databases.)

ALTER TABLE seen ADD COLUMN board TEXT;
ALTER TABLE postings ADD COLUMN source_board TEXT;
ALTER TABLE postings ADD COLUMN source_kind TEXT;
ALTER TABLE runs ADD COLUMN log TEXT;

-- Backfill provenance for rows written before boards were tracked.
UPDATE seen SET board = CASE
  WHEN source_url LIKE '%greenhouse.io%' THEN 'Greenhouse'
  WHEN source_url LIKE '%lever.co%' THEN 'Lever'
  WHEN source_url LIKE '%ashbyhq.com%' THEN 'Ashby'
  WHEN source_url LIKE '%smartrecruiters.com%' THEN 'SmartRecruiters'
  WHEN source_url LIKE '%personio.%' THEN 'Personio'
  WHEN source_url LIKE '%teamtailor.com%' THEN 'Teamtailor'
  WHEN source_url LIKE '%recruitee.com%' THEN 'Recruitee'
  ELSE NULL END
WHERE board IS NULL;

UPDATE postings SET source_board = CASE
  WHEN source_url LIKE '%greenhouse.io%' THEN 'Greenhouse'
  WHEN source_url LIKE '%lever.co%' THEN 'Lever'
  WHEN source_url LIKE '%ashbyhq.com%' THEN 'Ashby'
  WHEN source_url LIKE '%smartrecruiters.com%' THEN 'SmartRecruiters'
  WHEN source_url LIKE '%personio.%' THEN 'Personio'
  WHEN source_url LIKE '%teamtailor.com%' THEN 'Teamtailor'
  WHEN source_url LIKE '%recruitee.com%' THEN 'Recruitee'
  ELSE NULL END,
  source_kind = 'employer'
WHERE source_board IS NULL
  AND (source_url LIKE '%greenhouse.io%' OR source_url LIKE '%lever.co%' OR source_url LIKE '%ashbyhq.com%'
    OR source_url LIKE '%smartrecruiters.com%' OR source_url LIKE '%personio.%' OR source_url LIKE '%teamtailor.com%'
    OR source_url LIKE '%recruitee.com%');
