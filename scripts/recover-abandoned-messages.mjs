#!/usr/bin/env bun
// Recover pending_messages that were drained on worker restart.
// Criteria: status='failed', retry_count=0, started_processing_at_epoch=NULL.
// These never started processing — they're safe to requeue.
//
// Run with: `bun scripts/recover-abandoned-messages.mjs` (uses bun:sqlite).

import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new Database(join(homedir(), '.claude-mem', 'claude-mem.db'));
const rows = db.query(`
  SELECT id, tool_name, session_db_id, datetime(failed_at_epoch/1000,'unixepoch','localtime') as failed_ts
  FROM pending_messages
  WHERE status='failed' AND retry_count=0 AND started_processing_at_epoch IS NULL
  ORDER BY id DESC
`).all();

console.log(`Found ${rows.length} messages eligible for recovery.`);
console.log('Sample (newest 10):');
rows.slice(0, 10).forEach(r => console.log(`  pm#${r.id} ${r.tool_name} session=${r.session_db_id} failed=${r.failed_ts}`));

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) {
  console.log('\nDRY RUN. Pass --apply to actually recover these messages.');
  process.exit(0);
}

const res = db.query(`
  UPDATE pending_messages
  SET status='pending', failed_at_epoch=NULL
  WHERE status='failed' AND retry_count=0 AND started_processing_at_epoch IS NULL
`).run();
console.log(`\nRecovered ${res.changes} messages. Worker will pick them up within a few seconds.`);
