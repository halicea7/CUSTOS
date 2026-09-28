"""Merge and deduplicate findings from all sources into DB-ready dicts."""

import dataclasses
import re

from worker.analysis.sast import RawFinding

_STOPWORDS = {
    "the", "a", "an", "in", "of", "is", "are", "with", "and", "or",
    "to", "from", "by", "on", "at", "for", "use", "using", "via",
    "not", "no", "has", "have", "been", "this", "that", "its",
}


def _sig_words(title: str) -> frozenset[str]:
    """Extract significant words from a title for semantic comparison."""
    words = re.split(r"[\s_\-\.]+", title.lower())
    return frozenset(w for w in words if len(w) >= 3 and w not in _STOPWORDS)


def _is_semantic_dup(a: frozenset[str], b: frozenset[str]) -> bool:
    """True if two word-sets share enough vocabulary to be the same issue."""
    common = a & b
    if not common:
        return False
    # One specific word (len >= 5) in common, or two shorter words
    return any(len(w) >= 5 for w in common) or len(common) >= 2


_LINE_TOLERANCE = 5


def _same_location(llm: RawFinding, tool: RawFinding) -> bool:
    """True if an LLM finding plausibly points at the same place as a tool finding.

    Findings in different files are never the same issue. When both carry line
    numbers they must be within a few lines of each other.
    """
    if (llm.file_path or "").lower() != (tool.file_path or "").lower():
        return False
    if llm.line_start is not None and tool.line_start is not None:
        tool_end = tool.line_end or tool.line_start
        llm_end = llm.line_end or llm.line_start
        return (
            llm.line_start <= tool_end + _LINE_TOLERANCE
            and tool.line_start <= llm_end + _LINE_TOLERANCE
        )
    return True


def dedup_raw_findings(findings: list[RawFinding]) -> list[RawFinding]:
    """
    Two-pass deduplication on a mixed list of RawFindings.

    Pass 1 — exact key: (file_path, line_start, title prefix).
              SAST/config findings are ordered before LLM so they win ties.

    Pass 2 — semantic: an LLM finding is dropped when a kept non-LLM finding
              at the same location (same file, nearby lines) shares enough
              title vocabulary to be about the same issue. Tools and the model
              word the same root cause differently; location keeps unrelated
              issues that merely share a word ("injection") from colliding.
    """
    # Non-LLM first so they take priority in both passes
    ordered = sorted(findings, key=lambda f: 0 if f.source != "llm" else 1)

    # Pass 1: exact key dedup
    seen_keys: set[tuple] = set()
    after_pass1: list[RawFinding] = []
    for f in ordered:
        key = (
            (f.file_path or "").lower(),
            f.line_start or 0,
            f.title.lower().strip()[:60],
        )
        if key not in seen_keys:
            seen_keys.add(key)
            after_pass1.append(f)

    # Pass 2: semantic dedup of LLM findings against co-located tool findings
    tool_findings = [(f, _sig_words(f.title)) for f in after_pass1 if f.source != "llm"]
    deduped: list[RawFinding] = []
    for f in after_pass1:
        if f.source == "llm":
            words = _sig_words(f.title)
            if words and any(
                _same_location(f, tf) and _is_semantic_dup(words, tw) for tf, tw in tool_findings
            ):
                continue  # semantic duplicate — drop
        deduped.append(f)

    return deduped


def synthesize(*source_lists: list[RawFinding]) -> list[dict]:
    """Merge all source lists, deduplicate, and return dicts matching Finding columns."""
    all_findings: list[RawFinding] = []
    for lst in source_lists:
        all_findings.extend(lst)

    return [_to_dict(f) for f in dedup_raw_findings(all_findings)]


def _to_dict(f: RawFinding) -> dict:
    return dataclasses.asdict(f)
