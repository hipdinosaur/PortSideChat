#!/usr/bin/env python3
"""
Prepare the merged CMS podcast CSV for Supabase hybrid RAG upload.

Reads:
  Transcripts/Port Side - Podcast-feeds - merged.csv

Writes (JSONL + summary):
  Transcripts/supabase-ready/episodes.jsonl
  Transcripts/supabase-ready/chunks.jsonl
  Transcripts/supabase-ready/prep-summary.json

Each chunk carries denormalized episode metadata including categories so
retrieval filters/boosts do not require joins.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

WEB_BASE = "https://www.portsidepro.com/podcast-feed"
TARGET_TOKENS = 550
MAX_TOKENS = 800
MIN_TOKENS = 120

SPEAKER_LINE_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*$"
)
INLINE_SPEAKER_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*(.*)$"
)


def estimate_tokens(text: str) -> int:
    # Rough token estimate for English (~4 chars/token)
    return max(1, (len(text) + 3) // 4)


def parse_categories(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"[;,|]", raw)
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        c = p.strip().lower().replace(" ", "-")
        c = re.sub(r"-+", "-", c)
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def parse_published_at(raw: str | None) -> str | None:
    if not raw or not raw.strip():
        return None
    s = raw.strip()
    # CMS export: "Wed Dec 17 2025 00:00:00 GMT+0000 (Coordinated Universal Time)"
    m = re.match(
        r"^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})",
        s,
    )
    if m:
        try:
            dt = datetime.strptime(
                f"{m.group(1)} {m.group(2)} {m.group(3)} {m.group(4)}",
                "%b %d %Y %H:%M:%S",
            ).replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except ValueError:
            pass
    return None


def html_to_plain(transcript_html: str) -> str:
    text = transcript_html or ""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_turns(plain: str) -> list[dict]:
    turns: list[dict] = []
    current: dict | None = None

    for raw_line in plain.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        m = SPEAKER_LINE_RE.match(line)
        if m:
            if current and current["text"].strip():
                turns.append(current)
            current = {
                "speaker": m.group(1).strip(),
                "timestamp": m.group(2),
                "text": "",
            }
            continue

        m2 = INLINE_SPEAKER_RE.match(line)
        if m2:
            speaker, ts, rest = (
                m2.group(1).strip(),
                m2.group(2),
                (m2.group(3) or "").strip(),
            )
            if current and current["text"].strip():
                turns.append(current)
            current = {"speaker": speaker, "timestamp": ts, "text": rest}
            continue

        if current is None:
            current = {"speaker": "Unknown", "timestamp": "", "text": line}
        else:
            current["text"] = (
                f"{current['text']} {line}".strip() if current["text"] else line
            )

    if current and current["text"].strip():
        turns.append(current)
    return turns


def format_turn(turn: dict) -> str:
    speaker = turn["speaker"]
    ts = turn.get("timestamp") or ""
    body = (turn.get("text") or "").strip()
    if ts:
        return f"{speaker} ({ts}): {body}"
    return f"{speaker}: {body}"


SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")


def split_long_turn(text: str, target_tokens: int, max_tokens: int) -> list[str]:
    """Break an over-long turn into ~target_tokens pieces at sentence boundaries.

    Solo and Fireside Chat episodes carry a single speaker header and then the
    whole transcript as one turn, so without this a full episode becomes one
    unretrievable chunk that also overflows the embedding input limit.
    """
    pieces: list[str] = []
    buf: list[str] = []
    buf_tokens = 0

    def flush() -> None:
        nonlocal buf, buf_tokens
        if buf:
            pieces.append(" ".join(buf))
            buf = []
            buf_tokens = 0

    for sentence in SENTENCE_BOUNDARY_RE.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue

        # Unpunctuated runs can exceed max on their own; hard-wrap on words.
        while estimate_tokens(sentence) > max_tokens:
            words = sentence.split()
            take = max(1, len(words) * max_tokens // max(1, estimate_tokens(sentence)))
            flush()
            pieces.append(" ".join(words[:take]))
            sentence = " ".join(words[take:])

        s_tokens = estimate_tokens(sentence)
        if buf and buf_tokens + s_tokens > target_tokens:
            flush()
        buf.append(sentence)
        buf_tokens += s_tokens

    flush()
    return pieces


def expand_long_turns(
    turns: list[dict], target_tokens: int, max_tokens: int
) -> list[dict]:
    """Replace any turn larger than max_tokens with same-speaker sub-turns."""
    out: list[dict] = []
    for turn in turns:
        if estimate_tokens(format_turn(turn)) <= max_tokens:
            out.append(turn)
            continue
        for part in split_long_turn(turn.get("text") or "", target_tokens, max_tokens):
            out.append({**turn, "text": part})
    return out


def pack_chunks(
    turns: list[dict],
    *,
    target_tokens: int = TARGET_TOKENS,
    max_tokens: int = MAX_TOKENS,
    min_tokens: int = MIN_TOKENS,
) -> list[dict]:
    """Pack speaker turns into ~target_tokens chunks, splitting only over-long turns."""
    if not turns:
        return []

    chunks: list[dict] = []
    buf: list[dict] = []
    buf_tokens = 0

    def flush() -> None:
        nonlocal buf, buf_tokens
        if not buf:
            return
        content = "\n\n".join(format_turn(t) for t in buf)
        speakers: list[str] = []
        for t in buf:
            sp = t["speaker"]
            if sp and sp not in speakers and sp.lower() != "unknown":
                speakers.append(sp)
        chunks.append(
            {
                "content": content,
                "token_estimate": estimate_tokens(content),
                "speakers": speakers,
                "start_timestamp": buf[0].get("timestamp") or None,
                "end_timestamp": buf[-1].get("timestamp") or None,
            }
        )
        buf = []
        buf_tokens = 0

    for turn in expand_long_turns(turns, target_tokens, max_tokens):
        piece = format_turn(turn)
        t_tokens = estimate_tokens(piece)

        if buf and buf_tokens + t_tokens > target_tokens and buf_tokens >= min_tokens:
            flush()

        buf.append(turn)
        buf_tokens += t_tokens

        if buf_tokens >= max_tokens:
            flush()

    flush()

    # Merge undersized trailing chunk into the previous one when possible
    if len(chunks) >= 2 and chunks[-1]["token_estimate"] < min_tokens:
        tail = chunks.pop()
        prev = chunks[-1]
        if prev["token_estimate"] + tail["token_estimate"] <= max_tokens * 1.25:
            prev["content"] = prev["content"] + "\n\n" + tail["content"]
            prev["token_estimate"] = estimate_tokens(prev["content"])
            prev["end_timestamp"] = tail["end_timestamp"] or prev["end_timestamp"]
            for sp in tail["speakers"]:
                if sp not in prev["speakers"]:
                    prev["speakers"].append(sp)
        else:
            chunks.append(tail)

    return chunks


def strip_html_brief(raw: str | None, limit: int = 500) -> str | None:
    if not raw:
        return None
    plain = html_to_plain(raw)
    plain = re.sub(r"\s+", " ", plain).strip()
    if not plain:
        return None
    if len(plain) > limit:
        return plain[: limit - 1].rstrip() + "…"
    return plain


def podcast_index_int(raw: str | None) -> int | None:
    if not raw or not str(raw).strip():
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def build_episode(row: dict) -> dict:
    slug = (row.get("Slug") or "").strip()
    categories = parse_categories(row.get("Category"))
    transcript = (row.get("Transcript") or "").strip()
    return {
        "id": str(uuid.uuid4()),
        "cms_item_id": row["Item ID"],
        "podcast_index": podcast_index_int(row.get("Podcast Index")),
        "name": (row.get("Name") or "").strip(),
        "slug": slug,
        "web_url": f"{WEB_BASE}/{slug}" if slug else "",
        "guest_name": (row.get("Guest Name") or "").strip() or None,
        "guest_title": (row.get("Guest Position or Title") or "").strip() or None,
        "categories": categories,
        "short_description": (row.get("Short Description") or "").strip() or None,
        "show_notes_html": (row.get("Show Notes") or "").strip() or None,
        "podcast_length": (row.get("Podcast Length") or "").strip() or None,
        "spotify_embed": (row.get("Spotify Embed") or "").strip() or None,
        "next_slug": (row.get("Next") or "").strip() or None,
        "published_at": parse_published_at(row.get("Published Date") or row.get("Published On")),
        "has_transcript": bool(transcript),
    }


def build_chunks_for_episode(
    episode: dict,
    transcript_html: str,
    *,
    target_tokens: int = TARGET_TOKENS,
) -> list[dict]:
    plain = html_to_plain(transcript_html)
    turns = parse_turns(plain)
    if not turns and plain:
        turns = [{"speaker": "Unknown", "timestamp": "", "text": plain}]

    packed = pack_chunks(turns, target_tokens=target_tokens)
    out: list[dict] = []
    for i, ch in enumerate(packed):
        out.append(
            {
                "id": str(uuid.uuid4()),
                "episode_id": episode["id"],
                "cms_item_id": episode["cms_item_id"],
                "chunk_index": i,
                "content": ch["content"],
                "token_estimate": ch["token_estimate"],
                "speakers": ch["speakers"],
                "start_timestamp": ch["start_timestamp"],
                "end_timestamp": ch["end_timestamp"],
                # Denormalized metadata (categories + episode fields travel with every snippet)
                "podcast_index": episode["podcast_index"],
                "episode_name": episode["name"],
                "slug": episode["slug"],
                "web_url": episode["web_url"],
                "guest_name": episode["guest_name"],
                "guest_title": episode["guest_title"],
                "categories": list(episode["categories"]),
                "short_description": episode["short_description"],
                "podcast_length": episode["podcast_length"],
                "show_notes_excerpt": strip_html_brief(episode.get("show_notes_html")),
                "embedding": None,
            }
        )
    return out


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        type=Path,
        default=root / "Transcripts" / "Port Side - Podcast-feeds - merged.csv",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=root / "Transcripts" / "supabase-ready",
    )
    parser.add_argument("--target-tokens", type=int, default=TARGET_TOKENS)
    args = parser.parse_args()
    target_tokens = args.target_tokens

    with args.csv.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    episodes: list[dict] = []
    chunks: list[dict] = []
    skipped_no_slug = 0
    category_counts: dict[str, int] = {}

    for row in rows:
        if not (row.get("Item ID") or "").strip():
            continue
        if not (row.get("Slug") or "").strip():
            skipped_no_slug += 1
            continue

        episode = build_episode(row)
        episodes.append(episode)
        for cat in episode["categories"]:
            category_counts[cat] = category_counts.get(cat, 0) + 1

        transcript = (row.get("Transcript") or "").strip()
        if transcript:
            episode_chunks = build_chunks_for_episode(
                episode, transcript, target_tokens=target_tokens
            )
            chunks.extend(episode_chunks)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    episodes_path = args.out_dir / "episodes.jsonl"
    chunks_path = args.out_dir / "chunks.jsonl"
    summary_path = args.out_dir / "prep-summary.json"

    write_jsonl(episodes_path, episodes)
    write_jsonl(chunks_path, chunks)

    token_estimates = [c["token_estimate"] for c in chunks]
    with_t = sum(1 for e in episodes if e["has_transcript"])
    summary = {
        "source_csv": str(args.csv),
        "episodes_total": len(episodes),
        "episodes_with_transcript": with_t,
        "episodes_without_transcript": len(episodes) - with_t,
        "chunks_total": len(chunks),
        "skipped_no_slug": skipped_no_slug,
        "target_tokens": target_tokens,
        "token_estimate": {
            "min": min(token_estimates) if token_estimates else 0,
            "median": sorted(token_estimates)[len(token_estimates) // 2]
            if token_estimates
            else 0,
            "max": max(token_estimates) if token_estimates else 0,
            "avg": round(sum(token_estimates) / len(token_estimates), 1)
            if token_estimates
            else 0,
        },
        "categories": dict(sorted(category_counts.items())),
        "outputs": {
            "episodes": str(episodes_path),
            "chunks": str(chunks_path),
            "schema": str(root / "supabase" / "schema.sql"),
        },
        "notes": [
            "embedding is null — populate with text-embedding-3-small (1536-d) before hybrid semantic search",
            "categories and episode metadata are denormalized onto every chunk",
            "web_url = https://www.portsidepro.com/podcast-feed/{slug}",
        ],
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("=== Supabase RAG prep complete ===")
    print(f"Episodes:              {len(episodes)} ({with_t} with transcripts)")
    print(f"Chunks:                {len(chunks)}")
    if token_estimates:
        print(
            f"Token estimate:        "
            f"min={summary['token_estimate']['min']} "
            f"med={summary['token_estimate']['median']} "
            f"avg={summary['token_estimate']['avg']} "
            f"max={summary['token_estimate']['max']}"
        )
    print(f"Categories:            {summary['categories']}")
    print(f"Wrote episodes:        {episodes_path}")
    print(f"Wrote chunks:          {chunks_path}")
    print(f"Wrote summary:         {summary_path}")
    print(f"Schema:                {root / 'supabase' / 'schema.sql'}")


if __name__ == "__main__":
    main()
