#!/usr/bin/env python3
"""
Upload supabase-ready JSONL into public.episodes / public.chunks via PostgREST.

Requires:
  SUPABASE_URL
  SUPABASE_KEY  (anon key only works if insert policies exist, or use service role)

Usage:
  SUPABASE_URL=... SUPABASE_KEY=... python3 scripts/upload-supabase-rag.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
READY = ROOT / "Transcripts" / "supabase-ready"

EP_COLS = [
    "id",
    "cms_item_id",
    "podcast_index",
    "name",
    "slug",
    "web_url",
    "guest_name",
    "guest_title",
    "categories",
    "short_description",
    "show_notes_html",
    "podcast_length",
    "spotify_embed",
    "next_slug",
    "published_at",
    "has_transcript",
]

CH_COLS = [
    "id",
    "episode_id",
    "cms_item_id",
    "chunk_index",
    "content",
    "token_estimate",
    "speakers",
    "start_timestamp",
    "end_timestamp",
    "podcast_index",
    "episode_name",
    "slug",
    "web_url",
    "guest_name",
    "guest_title",
    "categories",
    "short_description",
    "podcast_length",
]


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def project(rows: list[dict], cols: list[str]) -> list[dict]:
    return [{k: r.get(k) for k in cols} for r in rows]


def upsert(url: str, key: str, table: str, rows: list[dict], on_conflict: str) -> None:
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}?on_conflict={on_conflict}"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError(f"{table}: unexpected status {resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{table} upload failed ({e.code}): {detail}") from e


def batched(rows: list[dict], size: int):
    for i in range(0, len(rows), size):
        yield i, rows[i : i + size]


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_KEY", file=sys.stderr)
        return 1

    episodes = project(load_jsonl(READY / "episodes.jsonl"), EP_COLS)
    chunks = project(load_jsonl(READY / "chunks.jsonl"), CH_COLS)
    print(f"Loaded {len(episodes)} episodes, {len(chunks)} chunks")

    # Episodes first (FK target)
    for start, batch in batched(episodes, 50):
        upsert(url, key, "episodes", batch, "id")
        print(f"  episodes {start + len(batch)}/{len(episodes)}")
        time.sleep(0.05)

    for start, batch in batched(chunks, 40):
        upsert(url, key, "chunks", batch, "id")
        print(f"  chunks {start + len(batch)}/{len(chunks)}")
        time.sleep(0.05)

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
