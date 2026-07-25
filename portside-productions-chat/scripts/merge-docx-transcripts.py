#!/usr/bin/env python3
"""
Merge local .docx podcast transcripts into the CMS podcast-feeds CSV.

Matching is guest-first (speakers in body + filename hints). Filename EP numbers
are a soft tie-break only — they often disagree with CMS Podcast Index.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from zipfile import ZipFile

HOST_NAMES = {
    "cole heilborn",
    "cole hilborn",
    "cole",
}

# Hard overrides: docx filename substring → CMS Podcast Index (guest-validated by hand)
DOCX_INDEX_OVERRIDES: dict[str, int] = {
    "sam van boxtel": 131,
    "justine mulliez": 95,
}

# Known alias pairs: alias -> canonical fragment used for matching
GUEST_ALIASES = {
    "lindsay rogers": "lindsay yaw rogers",
    "lindsay yaw rogers": "lindsay yaw rogers",
    "mike goldstein": "michael goldstein",
    "michael goldstein": "michael goldstein",
    "dough thielen": "doug thielen",
    "doug thielen": "doug thielen",
    "roberto guiterrez": "roberto gutierrez",
    "roberto gutierrez": "roberto gutierrez",
    "ben o meara": "ben omeara",
    "ben omeara": "ben omeara",
    "john entwhistle": "john entwistle",
    "john entwistle": "john entwistle",
    "kaim york feirn": "kami york feirn",
    "kami york feirn": "kami york feirn",
    "matt powell": "matt powell",
    "gary": "gary boulanger",
    "mike artz": "mike arzt",
    "mike arzt": "mike arzt",
    "rafael oliveria": "rafael oliveira",
    "rafael oliveira": "rafael oliveira",
    "becky little": "becky lyttle",
    "becky lyttle": "becky lyttle",
    "jon glassberg": "jon glassberg",
    "john glassberg": "jon glassberg",
}

EP_RE = re.compile(r"^(?:EP|Ep\.?)\s*(\d+)", re.I)
SPEAKER_LINE_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*$"
)
INLINE_SPEAKER_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\)\s*:?\s*(.*)$"
)


def norm(s: str | None) -> str:
    s = (s or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"\bq\s*(?:and|&)?\s*a\b", " qa ", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return GUEST_ALIASES.get(s, s)


def name_parts(s: str) -> list[str]:
    return [p for p in norm(s).split() if p]


def is_host(name: str) -> bool:
    n = norm(name)
    if n in HOST_NAMES:
        return True
    parts = name_parts(name)
    return bool(parts) and parts[0] == "cole" and (
        len(parts) == 1 or "heilborn" in parts or "hilborn" in parts
    )


def names_match(guest: str, candidate: str) -> str | None:
    """Return 'strong' | 'soft' | None.

    Requires at least a last-name (or full-name) signal. A single shared
    first name like "Chris" is not enough.
    """
    g = norm(guest)
    c = norm(candidate)
    if not g or not c:
        return None
    if g == c or g in c or c in g:
        # Avoid first-name-only containment ("chris" in "chris burkard") when
        # the shorter side is a single token under 5 chars? Actually "chris"
        # alone matching is OK for alias "gary"->"gary boulanger", but
        # CSV guests are rarely single-token. Require 2+ tokens on at least one side
        # unless exact equality after alias norm.
        gp, cp = name_parts(guest), name_parts(candidate)
        if g == c:
            return "strong"
        if min(len(gp), len(cp)) >= 1 and max(len(gp), len(cp)) >= 2:
            # full shorter name contained in longer (lindsay rogers in lindsay yaw rogers)
            if g in c or c in g:
                return "strong"
        return None
    gp, cp = name_parts(guest), name_parts(candidate)
    if len(gp) >= 2 and len(cp) >= 1 and gp[0] in cp and gp[-1] in cp:
        return "strong"
    if len(gp) >= 2 and gp[-1] in cp and len(gp[-1]) > 3:
        return "soft"
    if len(gp) == 1 and len(gp[0]) > 3 and gp[0] in cp and len(cp) >= 2:
        # alias single token mapped onto fuller name (gary -> gary boulanger)
        return "strong"
    return None


def guest_in_blob(guest: str, blob: str) -> str | None:
    g = norm(guest)
    b = norm(blob)
    if not g or not b:
        return None
    gp = name_parts(guest)
    if len(gp) >= 2 and g in b:
        return "strong"
    if len(gp) >= 2 and gp[0] in b and gp[-1] in b:
        return "strong"
    if len(gp) >= 2 and gp[-1] in b and len(gp[-1]) > 3:
        return "soft"
    if len(gp) == 1 and len(gp[0]) > 3 and gp[0] in b:
        return "soft"
    return None


def extract_docx_text(path: Path) -> str:
    with ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"</w:p>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def try_extract_docx_text(path: Path) -> str | None:
    try:
        return extract_docx_text(path)
    except Exception as exc:
        print(f"WARN: skipping unreadable docx {path.name}: {exc}")
        return None


def parse_turns(plain: str) -> list[dict]:
    """Parse speaker-timestamped transcript into turns."""
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
            # Only treat as speaker header if residual is empty or short continuation
            speaker, ts, rest = m2.group(1).strip(), m2.group(2), m2.group(3).strip()
            # Prefer splitting when this looks like a header line
            if current and current["text"].strip():
                turns.append(current)
            current = {"speaker": speaker, "timestamp": ts, "text": rest}
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
        sp = t["speaker"]
        if sp and sp not in out and sp.lower() != "unknown":
            out.append(sp)
    return out


def guest_speakers(speakers: list[str]) -> list[str]:
    skip_prefixes = ("speaker", "commercial", "music", "unknown")
    out = []
    for s in speakers:
        if is_host(s):
            continue
        low = s.lower().strip()
        if any(low.startswith(p) for p in skip_prefixes):
            continue
        out.append(s)
    return out


def turns_to_html(turns: list[dict]) -> str:
    parts: list[str] = []
    for t in turns:
        speaker = html.escape(t["speaker"])
        ts = t["timestamp"]
        header = f"{speaker} ({html.escape(ts)})" if ts else speaker
        body = html.escape(t["text"].strip())
        parts.append(f"<p>{header}</p><p>{body}</p>")
    return "".join(parts)


def filename_ep(stem: str) -> int | None:
    m = EP_RE.match(stem)
    return int(m.group(1)) if m else None


def scrub_host_from_text(text: str) -> str:
    """Remove host name tokens from a hint string."""
    t = text
    t = re.sub(r"\bcole\s+heil?born\b", " ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" ,-_")
    return t


def filename_hints(stem: str) -> list[str]:
    s = stem
    s = re.sub(r"^Copy of\s+", "", s, flags=re.I)
    s = re.sub(r"^(?:EP|Ep\.?)\s*\d+\.?\s*-?\s*", "", s, flags=re.I)
    s = re.sub(
        r"\s*-\s*Backcountry Marketing Podcast\s*$",
        "",
        s,
        flags=re.I,
    )
    s = re.sub(
        r"\s+(Transcript|TRanscriptr|Trancscript|audio episode|Audio Episode|Audio episode|audio)\s*$",
        "",
        s,
        flags=re.I,
    )
    raw_parts = [p.strip() for p in re.split(r"\s+_\s+", s) if p.strip()]
    if not raw_parts:
        raw_parts = [s.strip()] if s.strip() else []
    collapsed = scrub_host_from_text(re.sub(r"[-_]+", " ", s))
    if collapsed:
        raw_parts.append(collapsed)

    cleaned: list[str] = []
    seen: set[str] = set()
    for p in raw_parts:
        chunks = re.split(r"\s{2,}|(?:\s+&\s+)", p)
        for chunk in chunks:
            chunk = scrub_host_from_text(chunk.strip(" ,"))
            if not chunk or is_host(chunk):
                continue
            # Drop generic production company hints
            if norm(chunk) in {"port side productions", "portside productions", "port side"}:
                continue
            key = norm(chunk)
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(chunk)
    return cleaned


def row_has_transcript(row: dict) -> bool:
    return bool((row.get("Transcript") or "").strip())


def guest_matches_row(row: dict, speakers: list[str], hints: list[str]) -> str | None:
    """Best strength of guest match against a CSV row.

    Rows with a Guest Name must match that guest (speakers or filename).
    Rows with an empty Guest Name only match when a guest speaker/hint
    appears in the episode Name (never via hint↔speaker alone).
    """
    guest = (row.get("Guest Name") or "").strip()
    name = (row.get("Name") or "").strip()
    strengths: list[str] = []
    hint_blob = " ".join(hints)

    if guest:
        for sp in speakers:
            hit = names_match(guest, sp)
            if hit:
                strengths.append(hit)
        hit = guest_in_blob(guest, hint_blob)
        if hit:
            strengths.append(hit)
        # Host listed as Guest Name (solo/co-host shows): also match non-host
        # speakers that appear in the episode title (e.g. Freelancing Q&A with Emily).
        if is_host(guest):
            for sp in speakers:
                if guest_in_blob(sp, name) == "strong":
                    strengths.append("strong")
            for hint in hints:
                if len(name_parts(hint)) >= 2 and guest_in_blob(hint, name) == "strong":
                    strengths.append("strong")
    else:
        # Empty Guest Name: only link if speaker/hint is reflected in episode Name
        for sp in speakers:
            hit = guest_in_blob(sp, name)
            if hit == "strong":
                strengths.append("strong")
        for hint in hints:
            if len(name_parts(hint)) < 2:
                continue
            hit = guest_in_blob(hint, name)
            if hit == "strong":
                strengths.append("strong")

    if "strong" in strengths:
        return "strong"
    if "soft" in strengths:
        return "soft"
    return None


def find_candidate_rows(
    rows: list[dict],
    speakers: list[str],
    hints: list[str],
    *,
    strong_only: bool = True,
) -> list[tuple[dict, str]]:
    cands: list[tuple[dict, str]] = []
    for row in rows:
        strength = guest_matches_row(row, speakers, hints)
        if not strength:
            continue
        if strong_only and strength != "strong":
            continue
        cands.append((row, strength))
    return cands


def choose_match(
    cands: list[tuple[dict, str]],
    file_ep: int | None,
    hints: list[str] | None = None,
) -> tuple[dict | None, str, str]:
    """
    Returns (row|None, status, reason).
    status: aligned | ambiguous | already_present | unmatched
    """
    if not cands:
        return None, "unmatched", "no guest match against CMS rows"

    strong = [(r, s) for r, s in cands if s == "strong"]
    pool = strong if strong else cands

    by_id: dict[str, tuple[dict, str]] = {}
    for row, strength in pool:
        iid = row["Item ID"]
        if iid not in by_id or (strength == "strong" and by_id[iid][1] != "strong"):
            by_id[iid] = (row, strength)
    unique = list(by_id.values())

    missing = [(r, s) for r, s in unique if not row_has_transcript(r)]
    present = [(r, s) for r, s in unique if row_has_transcript(r)]

    # Prefer rows that have a real Guest Name over empty-guest Name-only matches
    named_missing = [
        (r, s) for r, s in missing if (r.get("Guest Name") or "").strip()
    ]
    if named_missing:
        missing = named_missing

    def ep_tiebreak(items: list[tuple[dict, str]]) -> list[tuple[dict, str]]:
        if file_ep is None or len(items) <= 1:
            return items
        exact = [
            (r, s)
            for r, s in items
            if (r.get("Podcast Index") or "").strip() == str(file_ep)
        ]
        return exact if len(exact) == 1 else items

    def title_tiebreak(items: list[tuple[dict, str]]) -> list[tuple[dict, str]]:
        """Prefer episodes whose Name shares a non-person filename hint."""
        if not hints or len(items) <= 1:
            return items
        person_like = []
        topic_hints = []
        for h in hints:
            if len(name_parts(h)) <= 3 and any(
                p[0:1].isupper() for p in h.split() if p
            ) and len(name_parts(h)) >= 2:
                # could be person or title; treat short 2-3 token as possible person
                # Topic hints tend to be longer or include QA/marketing words
                pass
            topic_hints.append(h)

        scored: list[tuple[int, tuple[dict, str]]] = []
        for item in items:
            name = item[0].get("Name") or ""
            nn = norm(name)
            score = 0
            for h in hints:
                hn = norm(h)
                if len(hn) < 4:
                    continue
                tokens = [t for t in h.split() if t]
                looks_like_person = len(tokens) in (2, 3) and all(
                    t[0:1].isupper() for t in tokens if t[0:1].isalpha()
                )
                if hn in nn:
                    score += 1 if looks_like_person else 5
                    continue
                stop = {
                    "cole",
                    "heilborn",
                    "hilborn",
                    "and",
                    "the",
                    "a",
                    "port",
                    "side",
                    "productions",
                }
                h_tokens = [t for t in hn.split() if t not in stop]
                n_tokens = set(nn.split())
                overlap = [t for t in h_tokens if t in n_tokens and len(t) > 3]
                if len(overlap) >= 2:
                    score += len(overlap) * (1 if looks_like_person else 2)
                elif len(overlap) == 1 and len(overlap[0]) > 6:
                    score += 3 if not looks_like_person else 1
            scored.append((score, item))
        best = max(s for s, _ in scored)
        if best <= 0:
            return items
        narrowed = [item for s, item in scored if s == best]
        return narrowed if narrowed else items

    if len(missing) == 1:
        return missing[0][0], "aligned", "unique missing-transcript guest match"

    if len(missing) > 1:
        tied = title_tiebreak(missing)
        if len(tied) == 1:
            return (
                tied[0][0],
                "aligned",
                "guest match narrowed by filename title hint",
            )
        tied = ep_tiebreak(tied)
        if len(tied) == 1:
            return (
                tied[0][0],
                "aligned",
                f"guest match narrowed by filename EP {file_ep}",
            )
        idxs = sorted({(r.get("Podcast Index") or "?") for r, _ in missing})
        return (
            None,
            "ambiguous",
            f"multiple missing-transcript episodes for guest: indexes {idxs}",
        )

    # All candidate episodes already have transcripts
    if len(unique) == 1:
        return unique[0][0], "already_present", "only matching episode already has transcript"
    if present and not missing:
        tied = ep_tiebreak(unique)
        if len(tied) == 1:
            return tied[0][0], "already_present", "matching episode already has transcript"
        idxs = sorted({(r.get("Podcast Index") or "?") for r, _ in unique})
        return (
            unique[0][0],
            "already_present",
            f"all matching episodes already have transcripts: indexes {idxs}",
        )

    return None, "unmatched", "no usable candidate"


def parse_speakers_from_html(transcript_html: str) -> list[str]:
    plain = re.sub(r"<br\s*/?>", "\n", transcript_html or "", flags=re.I)
    plain = re.sub(r"</p>", "\n", plain, flags=re.I)
    plain = re.sub(r"<[^>]+>", "", plain)
    plain = html.unescape(plain)
    found = re.findall(
        r"^([A-Za-z][A-Za-z0-9 .'\-]{0,60}?)\s*\(\d{1,2}:\d{2}",
        plain,
        re.M,
    )
    out: list[str] = []
    for s in found:
        s = s.strip()
        if s and s not in out:
            out.append(s)
    return out


def validate_transcript_rows(rows: list[dict]) -> list[dict]:
    issues: list[dict] = []
    for row in rows:
        if not row_has_transcript(row):
            continue
        transcript = row["Transcript"]
        speakers = parse_speakers_from_html(transcript)
        guests = guest_speakers(speakers)
        csv_guest = (row.get("Guest Name") or "").strip()
        name = (row.get("Name") or "").strip()
        plain = re.sub(r"<[^>]+>", " ", transcript)
        plain = re.sub(r"\s+", " ", plain)

        ok = False
        reason = ""
        if csv_guest:
            if is_host(csv_guest) and not guests:
                ok = True
                reason = "host listed as guest"
            for sp in speakers:
                if names_match(csv_guest, sp):
                    ok = True
                    break
            if not ok and guest_in_blob(csv_guest, " ".join(speakers)):
                ok = True
            if not ok and (" and " in csv_guest.lower() or "," in csv_guest):
                parts = re.split(r"\s+and\s+|,", csv_guest, flags=re.I)
                if all(
                    any(names_match(p.strip(), sp) for sp in speakers)
                    for p in parts
                    if p.strip() and len(name_parts(p)) >= 2
                ):
                    ok = True
            if not ok:
                short = csv_guest.split(" is ")[0].strip()
                if any(names_match(short, sp) for sp in speakers):
                    ok = True
            # Fallback: guest name appears in transcript body (speaker labels vary)
            if not ok and guest_in_blob(csv_guest.split(" is ")[0].strip(), plain):
                ok = True
            if not ok:
                reason = reason or "csv Guest Name not found among transcript speakers"
        else:
            if not guests:
                ok = True
                reason = "host-only / no guest speakers"
            else:
                for sp in guests:
                    if guest_in_blob(sp, name) or names_match(sp, name):
                        ok = True
                        break
                if not ok:
                    for sp in guests:
                        parts = name_parts(sp)
                        if parts and parts[-1] in norm(name) and len(parts[-1]) > 3:
                            ok = True
                            break
                if not ok:
                    # Truncated CMS titles sometimes cut the last name mid-word
                    for sp in guests:
                        parts = name_parts(sp)
                        if parts and parts[0] in norm(name) and len(parts[0]) > 3:
                            ok = True
                            break
                if not ok:
                    reason = "empty Guest Name and speakers not reflected in episode Name"

        if not ok:
            issues.append(
                {
                    "item_id": row["Item ID"],
                    "podcast_index": row.get("Podcast Index"),
                    "name": name,
                    "csv_guest": csv_guest,
                    "transcript_speakers": speakers[:12],
                    "guest_speakers": guests[:12],
                    "reason": reason,
                }
            )
    return issues


def resolve_override_row(path_name: str, rows: list[dict]) -> dict | None:
    """Return CMS row for a hard-coded docx → podcast_index override."""
    key = norm(path_name)
    target_idx: int | None = None
    for needle, idx in DOCX_INDEX_OVERRIDES.items():
        if needle in key:
            target_idx = idx
            break
    if target_idx is None:
        return None
    matches = [
        r
        for r in rows
        if (r.get("Podcast Index") or "").strip() == str(target_idx)
    ]
    if not matches:
        return None
    # Prefer non-draft if present
    matches = sorted(
        matches,
        key=lambda r: (
            (r.get("Draft") or "false").lower() != "false",
            (r.get("Archived") or "false").lower() != "false",
        ),
    )
    return matches[0]


def is_throwback(row: dict) -> bool:
    name = row.get("Name") or ""
    return bool(re.search(r"\bthrowback\b|\bre-?publish\b|\bencore\b", name, re.I))


def duplicate_indexes(rows: list[dict]) -> dict[str, list[str]]:
    by_idx: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        idx = (row.get("Podcast Index") or "").strip()
        if idx:
            by_idx[idx].append(row["Item ID"])
    return {k: v for k, v in by_idx.items() if len(v) > 1}

    by_idx: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        idx = (row.get("Podcast Index") or "").strip()
        if idx:
            by_idx[idx].append(row["Item ID"])
    return {k: v for k, v in by_idx.items() if len(v) > 1}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument(
        "--csv",
        type=Path,
        default=root
        / "Transcripts"
        / "Port Side - Podcast-feeds - 68225dfc7bb476527f8c468d.csv",
    )
    parser.add_argument(
        "--docx-dir",
        type=Path,
        default=root / "Transcripts",
    )
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
        "--force",
        action="store_true",
        help="Overwrite non-empty CMS Transcript cells (default: skip)",
    )
    args = parser.parse_args()

    with args.csv.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    rows_by_id = {r["Item ID"]: r for r in rows}
    docx_files = sorted(
        p for p in args.docx_dir.glob("*.docx") if not p.name.startswith("~$")
    )

    filled = 0
    skipped_force = 0
    claimed_items: set[str] = set()

    # First pass: score all files
    pending: list[dict] = []
    for path in docx_files:
        plain = try_extract_docx_text(path)
        if plain is None:
            pending.append(
                {
                    "source_file": path.name,
                    "file_ep": filename_ep(path.stem),
                    "docx_speakers": [],
                    "guest_speakers": [],
                    "filename_hints": [],
                    "status": "unreadable",
                    "reason": "docx could not be opened",
                    "ep_mismatch_warning": False,
                    "item_id": None,
                    "podcast_index": None,
                    "csv_guest": None,
                    "csv_name": None,
                    "candidate_indexes": [],
                }
            )
            continue
        turns = parse_turns(plain)
        speakers = speakers_from_turns(turns)
        guests = guest_speakers(speakers)
        hints = filename_hints(path.stem)
        file_ep = filename_ep(path.stem)
        html_body = turns_to_html(turns) if turns else f"<p>{html.escape(plain)}</p>"

        cands = find_candidate_rows(rows, guests, hints, strong_only=True)
        # Fall back to soft matches only when no strong hit
        if not cands:
            cands = find_candidate_rows(rows, guests, hints, strong_only=False)
        # If still nothing and we have no guest speakers, try filename hints vs Name/Guest
        if not cands and not guests:
            cands = find_candidate_rows(rows, hints, hints, strong_only=True)
        row, status, reason = choose_match(cands, file_ep, hints)

        override_row = resolve_override_row(path.name, rows)
        if override_row is not None:
            row = override_row
            status = "aligned"
            reason = (
                f"hard override → Podcast Index {override_row.get('Podcast Index')}"
            )
            cands = [(override_row, "strong")]

        # Detect EP mismatch when file_ep points at different guest
        ep_mismatch = False
        if file_ep is not None:
            ep_rows = [
                r
                for r in rows
                if (r.get("Podcast Index") or "").strip() == str(file_ep)
            ]
            if ep_rows and row and ep_rows[0]["Item ID"] != row["Item ID"]:
                ep_guest = (ep_rows[0].get("Guest Name") or "").strip()
                if guests and ep_guest:
                    if not any(names_match(ep_guest, g) for g in guests):
                        ep_mismatch = True

        # Skip throwback targets even if matched
        if row and is_throwback(row):
            decision = {
                "source_file": path.name,
                "file_ep": file_ep,
                "docx_speakers": speakers,
                "guest_speakers": guests,
                "filename_hints": hints,
                "status": "skipped_throwback",
                "reason": f"target episode is a throwback: {row.get('Name')}",
                "ep_mismatch_warning": ep_mismatch,
                "item_id": row["Item ID"],
                "podcast_index": row.get("Podcast Index"),
                "csv_guest": row.get("Guest Name"),
                "csv_name": row.get("Name"),
                "candidate_indexes": sorted(
                    {(r.get("Podcast Index") or "?") for r, _ in cands}
                ),
            }
            pending.append(decision)
            continue

        decision = {
            "source_file": path.name,
            "file_ep": file_ep,
            "docx_speakers": speakers,
            "guest_speakers": guests,
            "filename_hints": hints,
            "status": status,
            "reason": reason,
            "ep_mismatch_warning": ep_mismatch,
            "item_id": row["Item ID"] if row else None,
            "podcast_index": row.get("Podcast Index") if row else None,
            "csv_guest": (row.get("Guest Name") if row else None),
            "csv_name": (row.get("Name") if row else None),
            "candidate_indexes": sorted(
                {
                    (r.get("Podcast Index") or "?")
                    for r, _ in cands
                }
            ),
            "_html": html_body,
        }
        if status == "aligned" and ep_mismatch:
            decision["reason"] = (
                reason + f"; filename EP {file_ep} points at different CMS guest"
            )
        pending.append(decision)

    # Apply merges: one transcript per Item ID (prefer EP tie when competing)
    aligned = [d for d in pending if d["status"] == "aligned" and d["item_id"]]
    by_item: dict[str, list[dict]] = defaultdict(list)
    for d in aligned:
        by_item[d["item_id"]].append(d)

    for item_id, group in by_item.items():
        row = rows_by_id[item_id]
        if row_has_transcript(row) and not args.force:
            for d in group:
                d["status"] = "already_present"
                d["reason"] = "target row already has transcript (skipped)"
            skipped_force += len(group)
            continue

        if len(group) > 1:
            idx = (row.get("Podcast Index") or "").strip()
            exact = [
                d
                for d in group
                if d["file_ep"] is not None and str(d["file_ep"]) == idx
            ]
            chosen = exact[0] if len(exact) == 1 else group[0]
            for d in group:
                if d is chosen:
                    continue
                d["status"] = "ambiguous"
                d["reason"] = (
                    f"multiple docx mapped to same item_id; kept {chosen['source_file']}"
                )
        else:
            chosen = group[0]

        row["Transcript"] = chosen["_html"]
        chosen["status"] = "filled"
        chosen["reason"] = chosen.get("reason") or "merged"
        claimed_items.add(item_id)
        filled += 1

    # Single decision list for all files
    decisions: list[dict] = []
    for d in pending:
        d.pop("_html", None)
        decisions.append(d)

    # Post-validate all transcript rows
    validation_issues = validate_transcript_rows(rows)
    filled_ids = {d["item_id"] for d in decisions if d["status"] == "filled" and d.get("item_id")}
    for issue in validation_issues:
        issue["source"] = (
            "newly_merged" if issue["item_id"] in filled_ids else "preexisting_cms"
        )
    dupes = duplicate_indexes(rows)

    empty_guest_rows = [
        {
            "item_id": r["Item ID"],
            "podcast_index": r.get("Podcast Index"),
            "name": r.get("Name"),
        }
        for r in rows
        if not (r.get("Guest Name") or "").strip()
    ]

    with_t = sum(1 for r in rows if row_has_transcript(r))
    missing = len(rows) - with_t

    status_counts = Counter(d["status"] for d in decisions)
    report = {
        "summary": {
            "docx_files": len(docx_files),
            "cms_episodes": len(rows),
            "filled": filled,
            "with_transcript_after": with_t,
            "missing_transcript_after": missing,
            "status_counts": dict(status_counts),
            "validation_issue_count": len(validation_issues),
            "duplicate_podcast_indexes": dupes,
            "empty_guest_name_count": len(empty_guest_rows),
        },
        "decisions": decisions,
        "validation_issues": validation_issues,
        "empty_guest_names": empty_guest_rows,
    }

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)

    with args.report.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("=== Transcript merge complete ===")
    print(f"DOCX files:              {len(docx_files)}")
    print(f"Filled empty transcripts:{filled}")
    print(f"With transcript after:   {with_t}")
    print(f"Still missing:           {missing}")
    print(f"Status counts:           {dict(status_counts)}")
    print(f"Validation issues:       {len(validation_issues)}")
    print(f"Duplicate Podcast Index: {sorted(dupes)}")
    print(f"Wrote CSV:               {args.out_csv}")
    print(f"Wrote report:            {args.report}")


if __name__ == "__main__":
    main()
