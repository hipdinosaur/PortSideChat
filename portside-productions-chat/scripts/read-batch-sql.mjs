#!/usr/bin/env node
/**
 * Reassemble split SQL parts and print full query for a batch file.
 * Usage: node scripts/read-batch-sql.mjs chunks-000
 */
import fs from 'node:fs';
import path from 'node:path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: node read-batch-sql.mjs chunks-000');
  process.exit(1);
}

const dir = path.resolve(import.meta.dirname, '../.upload-parts', name);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
let sql = '';
for (let i = 0; i < meta.parts; i++) {
  sql += fs.readFileSync(path.join(dir, `part-${String(i).padStart(3, '0')}.txt`), 'utf8');
}
process.stdout.write(sql);
