#!/usr/bin/env node
/**
 * Upload chunk SQL batches by reading files and printing status JSON lines.
 * Agent uses read-batch-sql.mjs output with CallMcpTool execute_sql.
 * This script validates files and reports metadata.
 */
import fs from 'node:fs';
import path from 'node:path';

const batchDir = path.resolve(import.meta.dirname, '../Transcripts/supabase-ready/sql-batches');
const start = Number(process.argv[2] ?? 0);
const end = Number(process.argv[3] ?? 33);

for (let i = start; i <= end; i++) {
  const name = `chunks-${String(i).padStart(3, '0')}.sql`;
  const filePath = path.join(batchDir, name);
  const query = fs.readFileSync(filePath, 'utf8');
  console.log(JSON.stringify({ file: name, bytes: query.length, ok: query.trim().endsWith(';') }));
}
