// One-time migration of the old Artifact tracker's `seen` collection into D1, so the
// new pipeline never re-evaluates what's already been judged (including postings the
// candidate confirmed expired). Old records are keyed by slug; the new pipeline looks
// them up by canonical source URL, so each row's URL is canonicalised here.
//
//   node scripts/generate-seen-seed.ts <export-dir> > seed-seen.sql

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl } from "../src/canon.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/generate-seen-seed.ts <dir-of-exported-seen-json>");
  process.exit(1);
}

const q = (v: string | number) => (typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

const rows: string[] = [];
let skipped = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const id = file.replace(/\.json$/, "");
  const d = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const url = typeof d.sourceUrl === "string" ? d.sourceUrl : "";
  // Outage notes / sweep summaries aren't postings.
  if (!/^https?:\/\//i.test(url) || /^egress-outage|-batch-|-swept-/.test(id)) {
    skipped++;
    continue;
  }
  rows.push(
    `INSERT OR REPLACE INTO seen (id, date_evaluated, decision, score, source_url) VALUES (${q(id)}, ${q(d.dateEvaluated ?? new Date().toISOString())}, ${q(String(d.decision ?? "skip"))}, ${Number(d.score) || 0}, ${q(canonicalUrl(url))});`,
  );
}

console.log(`-- Migrated from the Artifact tracker's seen collection: ${rows.length} rows (${skipped} non-posting notes skipped).`);
console.log(rows.join("\n"));
