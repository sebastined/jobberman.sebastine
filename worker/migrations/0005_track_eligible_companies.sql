-- Gives the africa-remote and uk-remote tracks their own prioritised slice of the company crawl queue,
-- the same way sponsorship already has `sponsors`. Without this they were crawling the same undifferentiated
-- pool built mostly by italy-remote/sponsorship searches — companies with no plausible connection to either
-- track — and produced near-zero results. Run once against an existing database:
--   wrangler d1 execute jobberman --remote --file=./migrations/0005_track_eligible_companies.sql
-- (schema.sql already contains these columns for fresh databases.)

ALTER TABLE companies ADD COLUMN africa_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN uk_eligible INTEGER NOT NULL DEFAULT 0;
