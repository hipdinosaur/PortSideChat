#!/usr/bin/env node
/**
 * Reads chunk SQL batch files and prints JSON lines for MCP execute_sql uploads.
 * Each output line: {"file":"chunks-000.sql","query":"<full sql>"}
 */
import fs from 'node:fs';
import path from 'node:path';

const batchDir = path.resolve(
  '../Transcripts/supabase-ready/sql-batches',
  import.meta.dirname,
);

const start = Number(process.argv[2] ?? 0);
const end = Number(process.argv[3] ?? 33);

for (let i = start; i <= end; i++) {
  const name = `chunks-${String(i).padStart(3, '0')}.sql`;
  const filePath = path.join(batchDir, name);
  const query = fs.readFileSync(filePath, 'utf8');
  process.stdout.write(JSON.stringify({ file: name, query, bytes: query.length }) + '\n');
}
