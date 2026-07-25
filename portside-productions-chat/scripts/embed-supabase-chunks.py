#!/usr/bin/env python3
"""
Embed public.chunks.content with OpenAI text-embedding-3-small (1536-d)
and write vectors back to Supabase via PostgREST.

Requires:
  OPENAI_API_KEY
  SUPABASE_URL
  SUPABASE_KEY  (anon needs update policy, or use service role)

Usage:
  OPENAI_API_KEY=... SUPABASE_URL=... SUPABASE_KEY=... \\
    python3 scripts/embed-supabase-chunks.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL = "text-embedding-3-small"
DIMS = 1536
# OpenAI allows large batches; keep modest for payload size / rate limits
EMBED_BATCH = 64
# Max chars ~ rough safety under 8191 tokens (~4 chars/token)
MAX_CHARS = 30_000
FETCH_PAGE = 200


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"Missing required env: {name}")
    return v


def http_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: dict | list | None = None,
    timeout: int = 180,
) -> object:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed ({e.code}): {detail}") from e


def fetch_missing(supabase_url: str, key: str) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
    }
    while True:
        url = (
            f"{supabase_url.rstrip('/')}/rest/v1/chunks"
            f"?select=id,content&embedding=is.null"
            f"&order=id.asc"
            f"&offset={offset}&limit={FETCH_PAGE}"
        )
        batch = http_json(url, headers=headers)
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(batch)
        if len(batch) < FETCH_PAGE:
            break
        offset += FETCH_PAGE
        time.sleep(0.05)
    return rows


def embed_batch(openai_key: str, texts: list[str]) -> list[list[float]]:
    payload = {
        "model": MODEL,
        "input": texts,
        "dimensions": DIMS,
    }
    result = http_json(
        "https://api.openai.com/v1/embeddings",
        method="POST",
        headers={
            "Authorization": f"Bearer {openai_key}",
            "Content-Type": "application/json",
        },
        body=payload,
    )
    assert isinstance(result, dict)
    data = sorted(result["data"], key=lambda d: d["index"])
    vectors = [d["embedding"] for d in data]
    if len(vectors) != len(texts):
        raise RuntimeError(f"Expected {len(texts)} embeddings, got {len(vectors)}")
    return vectors


def upsert_embeddings(
    supabase_url: str, key: str, rows: list[dict]
) -> None:
    """Batch-update embeddings via RPC (id + vector string)."""
    items = [
        {"id": r["id"], "embedding": "[" + ",".join(str(float(v)) for v in r["embedding"]) + "]"}
        for r in rows
    ]
    url = f"{supabase_url.rstrip('/')}/rest/v1/rpc/update_chunk_embeddings"
    http_json(
        url,
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        body={"items": items},
    )


def main() -> int:
    openai_key = env("OPENAI_API_KEY")
    supabase_url = env("SUPABASE_URL")
    supabase_key = env("SUPABASE_KEY")

    print("Fetching chunks with null embeddings…")
    rows = fetch_missing(supabase_url, supabase_key)
    print(f"Found {len(rows)} chunks to embed")
    if not rows:
        print("Nothing to do.")
        return 0

    done = 0
    for i in range(0, len(rows), EMBED_BATCH):
        batch = rows[i : i + EMBED_BATCH]
        texts = []
        for r in batch:
            text = (r.get("content") or "").strip()
            if len(text) > MAX_CHARS:
                text = text[:MAX_CHARS]
            if not text:
                text = " "
            texts.append(text)

        # Retry once on transient failures
        for attempt in range(2):
            try:
                vectors = embed_batch(openai_key, texts)
                break
            except Exception as e:
                if attempt == 0:
                    print(f"  embed retry after error: {e}")
                    time.sleep(2)
                else:
                    raise

        payload = [{"id": r["id"], "embedding": vec} for r, vec in zip(batch, vectors)]
        upsert_embeddings(supabase_url, supabase_key, payload)

        done += len(batch)
        print(f"  embedded {done}/{len(rows)}")
        time.sleep(0.15)

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
