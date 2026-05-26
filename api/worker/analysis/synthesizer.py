"""Merge and deduplicate findings from all sources into DB-ready dicts."""

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


def dedup_raw_findings(findings: list[RawFinding]) -> list[RawFinding]:
    """
    Two-pass deduplication on a mixed list of RawFindings.

    Pass 1 — exact key: (file_path, line_start, title prefix).
              SAST/config findings are ordered before LLM so they win ties.

    Pass 2 — semantic: an LLM finding is dropped when a kept non-LLM finding
              shares enough title vocabulary to be about the same issue.
              Catches cases where tools report the same root cause with
              different wording and different (or absent) file references.
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

    # Pass 2: semantic dedup — drop LLM findings that overlap with a kept
    # non-LLM finding
    kept_non_llm_words: list[frozenset[str]] = [
        _sig_words(f.title) for f in after_pass1 if f.source != "llm"
    ]
    deduped: list[RawFinding] = []
    for f in after_pass1:
        if f.source == "llm":
            words = _sig_words(f.title)
            if words and any(_is_semantic_dup(words, w) for w in kept_non_llm_words):
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
    return {
        "source": f.source,
        "severity": f.severity,
        "title": f.title,
        "description": f.description,
        "file_path": f.file_path,
        "line_start": f.line_start,
        "line_end": f.line_end,
        "cwe": f.cwe,
        "code_snippet": f.code_snippet,
        "remediation": f.remediation,
        "llm_reasoning": f.llm_reasoning,
    }
