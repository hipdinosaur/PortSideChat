#!/usr/bin/env python3
"""
Curate the merged CMS CSV for Supabase upload.

Keeps only episodes that:
  - were linked to a local .docx (filled or already_present in the merge report)
  - are not throwbacks / re-publishes
  - have a non-empty Transcript

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
    name = row.get("Name") or ""
    return bool(re.search(r"\bthrowback\b|\bre-?publish\b|\bencore\b", name, re.I))


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
    keep_ids: set[str] = set()
    docx_by_item: dict[str, list[str]] = {}
    for d in report.get("decisions", []):
        if d.get("status") not in {"filled", "already_present"}:
            continue
        iid = d.get("item_id")
        if not iid:
            continue
        keep_ids.add(iid)
        docx_by_item.setdefault(iid, []).append(d.get("source_file") or "")

    with args.merged_csv.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    kept: list[dict] = []
    dropped_throwback: list[dict] = []
    dropped_no_docx: list[dict] = []
    dropped_no_transcript: list[dict] = []

    for row in rows:
        iid = row.get("Item ID") or ""
        name = row.get("Name") or ""
        has_t = bool((row.get("Transcript") or "").strip())
        meta = {
            "podcast_index": row.get("Podcast Index"),
            "name": name,
            "guest": row.get("Guest Name"),
            "item_id": iid,
        }

        if is_throwback(row):
            dropped_throwback.append(meta)
            continue
        if iid not in keep_ids:
            dropped_no_docx.append(meta)
            continue
        if not has_t:
            dropped_no_transcript.append(meta)
            continue

        kept.append(row)

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(kept)

    summary = {
        "source_merged_csv": str(args.merged_csv),
        "merge_report": str(args.report),
        "episodes_in_merged": len(rows),
        "episodes_kept": len(kept),
        "dropped_throwback": dropped_throwback,
        "dropped_no_local_docx": len(dropped_no_docx),
        "dropped_no_transcript": dropped_no_transcript,
        "dropped_no_docx_sample": dropped_no_docx[:40],
        "kept_indexes": sorted(
            {
                int(r["Podcast Index"])
                for r in kept
                if str(r.get("Podcast Index") or "").isdigit()
            }
        ),
        "sam_van_boxtel": [
            {
                "podcast_index": r.get("Podcast Index"),
                "name": r.get("Name"),
                "has_transcript": bool((r.get("Transcript") or "").strip()),
                "docx": docx_by_item.get(r["Item ID"], []),
            }
            for r in rows
            if "van boxtel" in ((r.get("Guest Name") or "") + (r.get("Name") or "")).lower()
        ],
        "justine": [
            {
                "podcast_index": r.get("Podcast Index"),
                "name": r.get("Name"),
                "has_transcript": bool((r.get("Transcript") or "").strip()),
                "kept": r["Item ID"] in {x["Item ID"] for x in kept},
                "docx": docx_by_item.get(r["Item ID"], []),
            }
            for r in rows
            if "justine" in ((r.get("Guest Name") or "") + (r.get("Name") or "")).lower()
        ],
        "output_csv": str(args.out_csv),
    }
    args.summary.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("=== Curated transcript corpus ===")
    print(f"Merged episodes:     {len(rows)}")
    print(f"Kept (docx-backed):  {len(kept)}")
    print(f"Dropped throwbacks:  {len(dropped_throwback)}")
    for t in dropped_throwback:
        print(f"  - EP {t['podcast_index']}: {t['name']}")
    print(f"Dropped no local docx: {len(dropped_no_docx)}")
    print(f"Dropped no transcript: {len(dropped_no_transcript)}")
    print(f"Wrote: {args.out_csv}")
    print(f"Summary: {args.summary}")


if __name__ == "__main__":
    main()
