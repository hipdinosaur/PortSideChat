#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const batchDir = path.resolve(import.meta.dirname, '../Transcripts/supabase-ready/sql-batches');
const idx = Number(process.argv[2]);
const name = `chunks-${String(idx).padStart(3, '0')}.sql`;
const sql = fs.readFileSync(path.join(batchDir, name), 'utf8');
process.stdout.write(`SET session_replication_role = 'replica';\n${sql}`);
