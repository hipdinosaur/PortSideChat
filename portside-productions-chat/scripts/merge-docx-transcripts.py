#!/usr/bin/env python3
"""
Merge local .docx podcast transcripts into the CMS podcast-feeds CSV.

The docx filenames carry authoritative episode numbers, so matching is
number-first. Resolution order per file:

  1. Episode number parsed from the CMS ``Name`` field. This is the real
     episode number and stays correct where the ``Podcast Index`` column
     is off by one (indexes 52/54/62 each cover two rows).
  2. The ``Podcast Index`` column, for the newest episodes whose titles
     carry no number.
  3. ``DOCX_EP_OVERRIDES`` for files whose own filename number is wrong.

Every match is then scored on title similarity and guest surname; anything
that fails both lands in the report's review list instead of being silently
accepted. Transcripts from docx overwrite whatever the CMS export held.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from zipfile import ZipFile

HOST_NAMES = {
    "cole heilborn",
    "cole hilborn",
    "cole",
}

# Files whose filename episode number disagrees with the transcript body.
# Each was confirmed by reading the docx speakers. Value is the true episode
# number as it appears in the CMS.
DOCX_EP_OVERRIDES: dict[str, int] = {
    # Body is Kyle Dufford; CMS 173 is the Mountainfilm episode.
    "EP 173_Seven Needs of Generation Z_Kyle Dufford.docx": 172,
    # Body is Kevin Knutson; CMS 180 is Cole's "Some Changes and Updates".
    "EP 180_Why Make Meaningful Content When the Algorithm Says Dance_ _ Kevin Knutson.docx": 181,
    # Body is Stix Nilsen; the Liquid Death episode is CMS 118.
    "EP 181_Fire Your Marketing Guy _ Stix Nilsen _ Liquid Death.docx": 118,
}

# Guest-name spellings that differ between the CMS and the docx filenames.
GUEST_ALIASES = {
    "swineheart": "swinehart",
    "weicchand": "weichhand",
    "oliveria": "oliveira",
    "guiterrez": "gutierrez",
    "entwhistle": "entwistle",
    "little": "lyttle",
    "oneil": "oneill",
    "artz": "arzt",
    "hilborn": "heilborn",
}

# Episode number at the start of a docx filename: "EP 12.", "Ep 122.", "EP 180_"
FILE_EP_RE = re.compile(r"^\s*(?:EP|Ep|Episode)\.?\s*[:#]?\s*(\d+)", re.I)
# Episode number at the start of a CMS Name: "Ep. 100:", "EP: 178", "Ep 52:"
NAME_EP_RE = re.compile(r"^\s*(?:EP|Ep|Episode)\.?\s*[:#]?\s*(\d+)", re.I)

SPEAKER_LINE_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*$"
)
INLINE_SPEAKER_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*(.*)$"
)

# A match clears verification if either signal is convincing on its own.
TITLE_SIMILARITY_OK = 0.45


def norm(s: str | None) -> str:
    s = (s or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def canonical_tokens(s: str | None) -> list[str]:
    return [GUEST_ALIASES.get(t, t) for t in norm(s).split() if t]


def is_host(name: str) -> bool:
    n = norm(name)
    if n in HOST_NAMES:
        return True
    parts = norm(name).split()
    return bool(parts) and parts[0] == "cole" and (
        len(parts) == 1 or "heilborn" in parts or "hilborn" in parts
    )


def extract_docx_text(path: Path) -> str:
    with ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"</w:p>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def try_extract_docx_text(path: Path) -> str | None:
    try:
        return extract_docx_text(path)
    except Exception as exc:
        print(f"WARN: skipping unreadable docx {path.name}: {exc}")
        return None


def parse_turns(plain: str) -> list[dict]:
    """Parse a speaker-timestamped transcript into turns."""
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
        if m2 and m2.group(3) is not None:
            if current and current["text"].strip():
                turns.append(current)
            current = {
                "speaker": m2.group(1).strip(),
                "timestamp": m2.group(2),
                "text": m2.group(3).strip(),
            }
            continue

        if current is None:
            current = {"speaker": "Unknown", "timestamp": "", "text": line}
        else:
            current["text"] = f"{current['text']} {line}".strip() if current["text"] else line

    if current and current["text"].strip():
        turns.append(current)

    return turns


def speakers_from_turns(turns: list[dict]) -> list[str]:
    out: list[str] = []
    for t in turns:
        sp = t["speaker"].strip()
        if sp and sp not in out and sp.lower() != "unknown":
            out.append(sp)
    return out


def guest_speakers(speakers: list[str]) -> list[str]:
    skip_prefixes = ("speaker", "commercial", "music", "unknown")
    out = []
    for s in speakers:
        if is_host(s):
            continue
        if any(s.lower().strip().startswith(p) for p in skip_prefixes):
            continue
        out.append(s)
    return out


def turns_to_html(turns: list[dict]) -> str:
    parts: list[str] = []
    for t in turns:
        speaker = html.escape(t["speaker"])
        ts = t["timestamp"]
        header = f"{speaker} ({html.escape(ts)})" if ts else speaker
        parts.append(f"<p>{header}</p><p>{html.escape(t['text'].strip())}</p>")
    return "".join(parts)


def file_ep(stem_or_name: str) -> int | None:
    m = FILE_EP_RE.match(stem_or_name)
    return int(m.group(1)) if m else None


def title_after_ep(text: str) -> str:
    """Strip the leading episode number so titles compare on words alone."""
    return re.sub(r"^\s*(?:EP|Ep|Episode)\.?\s*[:#]?\s*\d+\s*[.:_\-|]*\s*", "", text, flags=re.I)


def title_similarity(docx_stem: str, cms_name: str) -> float:
    return SequenceMatcher(
        None, norm(title_after_ep(docx_stem)), norm(title_after_ep(cms_name))
    ).ratio()


def guest_corroborated(docx_stem: str, docx_speakers: list[str], row: dict) -> bool:
    """True when the CMS guest shows up in the filename or the docx speakers."""
    guest = (row.get("Guest Name") or "").strip()
    if not guest:
        # Nothing to corroborate against; the episode number has to carry it.
        return False

    # CMS sometimes stores a bio ("Maddie Petry is the Marketing Director").
    guest = re.split(r"\bis\b", guest, maxsplit=1)[0]

    haystack = set(canonical_tokens(docx_stem))
    for sp in docx_speakers:
        haystack.update(canonical_tokens(sp))
    if not haystack:
        return False

    # Multi-guest episodes ("Sean Slobodan and Shandi Kano") only need one hit.
    for part in re.split(r"\s+and\s+|,|&", guest, flags=re.I):
        tokens = [t for t in canonical_tokens(part) if len(t) > 3]
        if tokens and any(t in haystack for t in tokens):
            return True
    return False


def build_index(rows: list[dict]) -> tuple[dict[int, dict], dict[int, dict]]:
    """Map episode number -> row, from the Name field and the Podcast Index."""
    by_name_ep: dict[int, dict] = {}
    name_collisions: dict[int, list[str]] = defaultdict(list)
    by_index: dict[int, dict] = {}

    for row in rows:
        ep = file_ep(row.get("Name") or "")
        if ep is not None:
            name_collisions[ep].append(row["Item ID"])
            by_name_ep.setdefault(ep, row)

        raw = (row.get("Podcast Index") or "").strip()
        if raw.isdigit():
            # First writer wins; duplicates are exactly the off-by-one rows
            # that the Name-derived number already resolves correctly.
            by_index.setdefault(int(raw), row)

    for ep, ids in name_collisions.items():
        if len(ids) > 1:
            print(f"WARN: CMS Name episode number {ep} appears on {len(ids)} rows: {ids}")

    return by_name_ep, by_index


def resolve_row(
    path: Path,
    ep: int | None,
    by_name_ep: dict[int, dict],
    by_index: dict[int, dict],
) -> tuple[dict | None, int | None, str]:
    """Return (row, resolved_ep, method)."""
    override = DOCX_EP_OVERRIDES.get(path.name)
    if override is not None:
        row = by_name_ep.get(override) or by_index.get(override)
        if row is not None:
            return row, override, "override"
        return None, override, "override_missing"

    if ep is None:
        return None, None, "no_episode_number"

    row = by_name_ep.get(ep)
    if row is not None:
        return row, ep, "cms_name_episode"

    row = by_index.get(ep)
    if row is not None:
        return row, ep, "podcast_index_column"

    return None, ep, "no_cms_row"


def parse_speakers_from_html(transcript_html: str) -> list[str]:
    plain = re.sub(r"<br\s*/?>", "\n", transcript_html or "", flags=re.I)
    plain = re.sub(r"</p>", "\n", plain, flags=re.I)
    plain = re.sub(r"<[^>]+>", "", plain)
    plain = html.unescape(plain)
    out: list[str] = []
    for s in re.findall(r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\(\d{1,2}:\d{2}", plain, re.M):
        s = s.strip()
        if s and s not in out:
            out.append(s)
    return out


def is_throwback(row: dict) -> bool:
    return bool(
        re.search(r"\bthrowback\b|\bre-?publish\b|\bencore\b", row.get("Name") or "", re.I)
    )


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        type=Path,
        default=root
        / "Transcripts"
        / "Port Side - Podcast-feeds - 68225dfc7bb476527f8c468d.csv",
    )
    parser.add_argument("--docx-dir", type=Path, default=root / "Transcripts")
    parser.add_argument(
        "--out-csv",
        type=Path,
        default=root / "Transcripts" / "Port Side - Podcast-feeds - merged.csv",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=root / "Transcripts" / "transcript-merge-report.json",
    )
    parser.add_argument(
        "--no-overwrite",
        action="store_true",
        help="Keep existing CMS Transcript cells (default: docx wins)",
    )
    args = parser.parse_args()

    with args.csv.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    rows_by_id = {r["Item ID"]: r for r in rows}
    by_name_ep, by_index = build_index(rows)

    docx_files = sorted(
        p for p in args.docx_dir.glob("*.docx") if not p.name.startswith("~$")
    )

    decisions: list[dict] = []
    for path in docx_files:
        ep = file_ep(path.stem)
        plain = try_extract_docx_text(path)
        if plain is None:
            decisions.append(
                {
                    "source_file": path.name,
                    "file_ep": ep,
                    "resolved_ep": None,
                    "method": "unreadable",
                    "status": "unreadable",
                    "reason": "docx could not be opened",
                }
            )
            continue

        turns = parse_turns(plain)
        speakers = speakers_from_turns(turns)
        row, resolved_ep, method = resolve_row(path, ep, by_name_ep, by_index)

        decision: dict = {
            "source_file": path.name,
            "file_ep": ep,
            "resolved_ep": resolved_ep,
            "method": method,
            "docx_speakers": speakers,
            "guest_speakers": guest_speakers(speakers),
        }

        if row is None:
            decision["status"] = "unmatched"
            decision["reason"] = {
                "no_episode_number": "filename carries no episode number",
                "no_cms_row": f"no CMS row for episode {resolved_ep}",
                "override_missing": f"override target episode {resolved_ep} not in CMS",
            }.get(method, "unresolved")
            decisions.append(decision)
            continue

        sim = title_similarity(path.stem, row.get("Name") or "")
        guest_ok = guest_corroborated(path.stem, speakers, row)
        decision.update(
            {
                "item_id": row["Item ID"],
                "podcast_index": row.get("Podcast Index"),
                "cms_name": row.get("Name"),
                "cms_guest": row.get("Guest Name"),
                "title_similarity": round(sim, 3),
                "guest_corroborated": guest_ok,
                "needs_review": not (guest_ok or sim >= TITLE_SIMILARITY_OK),
                "status": "skipped_throwback" if is_throwback(row) else "matched",
                "_html": turns_to_html(turns) if turns else f"<p>{html.escape(plain)}</p>",
            }
        )
        if decision["status"] == "skipped_throwback":
            decision["reason"] = f"target episode is a throwback: {row.get('Name')}"
        decisions.append(decision)

    # Apply merges. One transcript per Item ID; a collision means two docx
    # resolved to the same episode, which needs a human, not a coin flip.
    by_item: dict[str, list[dict]] = defaultdict(list)
    for d in decisions:
        if d["status"] == "matched":
            by_item[d["item_id"]].append(d)

    filled = 0
    skipped_existing = 0
    for item_id, group in by_item.items():
        row = rows_by_id[item_id]

        if len(group) > 1:
            names = [d["source_file"] for d in group]
            for d in group:
                d["status"] = "collision"
                d["reason"] = f"multiple docx resolved to this episode: {names}"
            continue

        chosen = group[0]
        if (row.get("Transcript") or "").strip() and args.no_overwrite:
            chosen["status"] = "skipped_existing"
            chosen["reason"] = "CMS row already has a transcript (--no-overwrite)"
            skipped_existing += 1
            continue

        had = bool((row.get("Transcript") or "").strip())
        row["Transcript"] = chosen["_html"]
        chosen["status"] = "filled"
        chosen["reason"] = "overwrote existing CMS transcript" if had else "filled empty cell"
        filled += 1

    for d in decisions:
        d.pop("_html", None)

    filled_ids = {d["item_id"] for d in decisions if d["status"] == "filled"}
    review = [
        {
            "source_file": d["source_file"],
            "resolved_ep": d["resolved_ep"],
            "method": d["method"],
            "cms_name": d.get("cms_name"),
            "cms_guest": d.get("cms_guest"),
            "title_similarity": d.get("title_similarity"),
            "docx_speakers": d.get("docx_speakers", [])[:6],
        }
        for d in decisions
        if d.get("needs_review")
    ]
    unmatched = [
        {"source_file": d["source_file"], "file_ep": d["file_ep"], "reason": d["reason"]}
        for d in decisions
        if d["status"] in {"unmatched", "unreadable"}
    ]
    collisions = [
        {"source_file": d["source_file"], "resolved_ep": d["resolved_ep"], "reason": d["reason"]}
        for d in decisions
        if d["status"] == "collision"
    ]

    with_t = sum(1 for r in rows if (r.get("Transcript") or "").strip())
    status_counts = Counter(d["status"] for d in decisions)

    report = {
        "summary": {
            "docx_files": len(docx_files),
            "cms_episodes": len(rows),
            "resolved": len(docx_files) - len(unmatched),
            "filled": filled,
            "skipped_existing": skipped_existing,
            "episodes_with_transcript_after": with_t,
            "episodes_missing_transcript_after": len(rows) - with_t,
            "status_counts": dict(status_counts),
            "needs_review_count": len(review),
            "unmatched_count": len(unmatched),
            "collision_count": len(collisions),
            "resolution_methods": dict(
                Counter(d["method"] for d in decisions if d["status"] == "filled")
            ),
        },
        "unmatched": unmatched,
        "collisions": collisions,
        "needs_review": review,
        "filled_episode_numbers": sorted(
            d["resolved_ep"] for d in decisions if d["status"] == "filled"
        ),
        "decisions": decisions,
    }

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)

    args.report.write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print("=== Transcript merge complete ===")
    print(f"DOCX files:            {len(docx_files)}")
    print(f"Resolved to CMS row:   {report['summary']['resolved']}")
    print(f"Transcripts written:   {filled}")
    print(f"Status counts:         {dict(status_counts)}")
    print(f"Resolution methods:    {report['summary']['resolution_methods']}")
    print(f"With transcript after: {with_t}")
    print(f"Needs review:          {len(review)}")
    for r in review:
        print(f"  - {r['source_file']} -> EP {r['resolved_ep']} ({r['cms_name']})")
    print(f"Unmatched:             {len(unmatched)}")
    for u in unmatched:
        print(f"  - {u['source_file']}: {u['reason']}")
    print(f"Collisions:            {len(collisions)}")
    for c in collisions:
        print(f"  - {c['source_file']}: {c['reason']}")
    print(f"Wrote CSV:             {args.out_csv}")
    print(f"Wrote report:          {args.report}")


if __name__ == "__main__":
    main()
