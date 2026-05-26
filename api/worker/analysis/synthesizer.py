"""Merge and deduplicate findings from all sources into DB-ready dicts."""

from worker.analysis.sast import RawFinding


def synthesize(*source_lists: list[RawFinding]) -> list[dict]:
    """Merge all source lists, deduplicate, and return dicts matching Finding columns."""
    all_findings: list[RawFinding] = []
    for lst in source_lists:
        all_findings.extend(lst)

    seen: set[tuple] = set()
    deduped: list[RawFinding] = []
    for f in all_findings:
        # Two findings are considered duplicates when they share the same
        # (file, line, normalised title prefix). The first-seen entry wins
        # so SAST findings (added before LLM) are preferred when they overlap.
        key = (
            (f.file_path or "").lower(),
            f.line_start or 0,
            _norm(f.title),
        )
        if key not in seen:
            seen.add(key)
            deduped.append(f)

    return [_to_dict(f) for f in deduped]


def _norm(title: str) -> str:
    return title.lower().strip()[:60]


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
