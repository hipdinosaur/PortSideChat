#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const batchDir = path.resolve(import.meta.dirname, '../Transcripts/supabase-ready/sql-batches');
const outDir = path.resolve(import.meta.dirname, '../.upload-parts');
const CHUNK_SIZE = 80000;

const files = fs.readdirSync(batchDir)
  .filter((f) => /^chunks-\d{3}\.sql$/.test(f))
  .sort();

fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const sql = fs.readFileSync(path.join(batchDir, file), 'utf8');
  const dir = path.join(outDir, file.replace('.sql', ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ file, bytes: sql.length, parts: Math.ceil(sql.length / CHUNK_SIZE) }));
  for (let i = 0, part = 0; i < sql.length; i += CHUNK_SIZE, part++) {
    fs.writeFileSync(path.join(dir, `part-${String(part).padStart(3, '0')}.txt`), sql.slice(i, i + CHUNK_SIZE));
  }
}

console.log(`Split ${files.length} files into ${outDir}`);
