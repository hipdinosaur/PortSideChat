#!/usr/bin/env python3
"""
Curate the merged CMS CSV for Supabase upload.

Keeps only episodes that:
  - had a local .docx merged into them (status "filled" in the merge report)
  - are not throwbacks / re-publishes
  - have a non-empty Transcript and a Slug (the chatbot cites by web_url)

Episodes whose only transcript came from the CMS export are dropped: the
corpus is deliberately limited to the verified docx set.

Writes:
  Transcripts/Port Side - Podcast-feeds - curated.csv
  Transcripts/curate-summary.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path


def is_throwback(row: dict) -> bool:
    return bool(
        re.search(r"\bthrowback\b|\bre-?publish\b|\bencore\b", row.get("Name") or "", re.I)
    )


def meta(row: dict) -> dict:
    return {
        "podcast_index": row.get("Podcast Index"),
        "name": row.get("Name"),
        "guest": row.get("Guest Name"),
        "item_id": row.get("Item ID"),
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--merged-csv",
        type=Path,
        default=root / "Transcripts" / "Port Side - Podcast-feeds - merged.csv",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=root / "Transcripts" / "transcript-merge-report.json",
    )
    parser.add_argument(
        "--out-csv",
        type=Path,
        default=root / "Transcripts" / "Port Side - Podcast-feeds - curated.csv",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=root / "Transcripts" / "curate-summary.json",
    )
    args = parser.parse_args()

    report = json.loads(args.report.read_text(encoding="utf-8"))
    docx_by_item: dict[str, list[str]] = {}
    for d in report.get("decisions", []):
        if d.get("status") != "filled" or not d.get("item_id"):
            continue
        docx_by_item.setdefault(d["item_id"], []).append(d.get("source_file") or "")
    keep_ids = set(docx_by_item)

    with args.merged_csv.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    kept: list[dict] = []
    dropped_throwback: list[dict] = []
    dropped_no_docx: list[dict] = []
    dropped_no_transcript: list[dict] = []
    dropped_no_slug: list[dict] = []

    for row in rows:
        if is_throwback(row):
            dropped_throwback.append(meta(row))
        elif (row.get("Item ID") or "") not in keep_ids:
            dropped_no_docx.append(meta(row))
        elif not (row.get("Transcript") or "").strip():
            dropped_no_transcript.append(meta(row))
        elif not (row.get("Slug") or "").strip():
            dropped_no_slug.append(meta(row))
        else:
            kept.append(row)

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(kept)

    multi = {k: v for k, v in docx_by_item.items() if len(v) > 1}
    summary = {
        "source_merged_csv": str(args.merged_csv),
        "merge_report": str(args.report),
        "episodes_in_merged": len(rows),
        "episodes_kept": len(kept),
        "docx_backed_items": len(keep_ids),
        "dropped_throwback": dropped_throwback,
        "dropped_no_local_docx": len(dropped_no_docx),
        "dropped_no_transcript": dropped_no_transcript,
        "dropped_no_slug": dropped_no_slug,
        "items_with_multiple_docx": multi,
        "unmatched_docx": report.get("unmatched", []),
        "kept_episode_numbers": sorted(
            {
                int(r["Podcast Index"])
                for r in kept
                if str(r.get("Podcast Index") or "").isdigit()
            }
        ),
        "output_csv": str(args.out_csv),
    }
    args.summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print("=== Curated transcript corpus ===")
    print(f"Merged episodes:       {len(rows)}")
    print(f"Docx-backed items:     {len(keep_ids)}")
    print(f"Kept:                  {len(kept)}")
    print(f"Dropped throwbacks:    {len(dropped_throwback)}")
    for t in dropped_throwback:
        print(f"  - EP {t['podcast_index']}: {t['name']}")
    print(f"Dropped no local docx: {len(dropped_no_docx)}")
    print(f"Dropped no transcript: {len(dropped_no_transcript)}")
    print(f"Dropped no slug:       {len(dropped_no_slug)}")
    for t in dropped_no_slug:
        print(f"  - EP {t['podcast_index']}: {t['name']}")
    print(f"Wrote:                 {args.out_csv}")
    print(f"Summary:               {args.summary}")


if __name__ == "__main__":
    main()
