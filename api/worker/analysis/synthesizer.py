"""Merge and deduplicate findings from all sources into DB-ready dicts."""

import dataclasses
import posixpath
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

    # Pass 2: an LLM finding about the same thing as a co-located tool finding is
    # folded into it (the tool's severity stands; the model's reasoning is kept).
    tool_findings = [(f, _sig_words(f.title)) for f in after_pass1 if f.source != "llm"]
    deduped: list[RawFinding] = []
    for f in after_pass1:
        if f.source == "llm":
            words = _sig_words(f.title)
            match = next((tf for tf, tw in tool_findings if _same_location(f, tf) and (
                (words and _is_semantic_dup(words, tw))
                or (f.cwe and tf.cwe and f.cwe.upper() == tf.cwe.upper())
                or (f.line_start is not None and f.line_start == tf.line_start)
            )), None)
            if match is not None:
                if f.llm_reasoning and not match.llm_reasoning:
                    match.llm_reasoning = f.llm_reasoning
                continue
        deduped.append(f)

    return _fold_second_opinions(deduped)


# Tools that repeat what Semgrep already finds: one finding per issue, crediting both.
_SECOND_OPINION = {"bandit": "Bandit", "checkov": "Checkov"}
_FOLD_LINES = 2
# Words every Checkov or Semgrep title has, which say nothing about the issue.
_GENERIC = {"ensure", "that", "have", "been", "added", "security", "dockerfile", "yaml", "github", "actions",
            "workflow", "workflows", "container", "audit", "lang", "python", "javascript", "rule"}


def _repeats(f: RawFinding, s: RawFinding) -> bool:
    """True if second-opinion finding *f* is about the same thing as Semgrep finding *s*."""
    if (s.file_path or "").lower() != (f.file_path or "").lower() or s.line_start is None or f.line_start is None:
        return False
    if f.source == "bandit":   # line-precise; the two tools often pick different CWEs for one call
        same_cwe = bool(f.cwe and s.cwe and s.cwe.upper() == f.cwe.upper())
        return s.line_start == f.line_start or (same_cwe and abs(s.line_start - f.line_start) <= _FOLD_LINES)
    # Checkov reports a whole resource (often the whole Dockerfile) and no CWE:
    # Semgrep's line inside that range, and a shared word that isn't boilerplate.
    if not f.line_start - _FOLD_LINES <= s.line_start <= (f.line_end or f.line_start) + _FOLD_LINES:
        return False
    words = (_sig_words(f.title.split(" ", 1)[-1]) & _sig_words(s.title)) - _GENERIC
    return any(len(w) >= 4 for w in words)


def _credit(match: RawFinding, note: str) -> None:
    if note not in (match.description or ""):
        match.description = f"{match.description}\n\n{note}" if match.description else note


def _dir(path: str | None) -> str:
    return posixpath.dirname((path or "").lstrip("/").lower())


def _package(f: RawFinding) -> str | None:
    """The package a dependency finding is about: "pyjwt 2.1: CVE-…" or npm audit's "pyjwt: title"."""
    m = _ADVISORY.match(f.title)
    if m:
        return m["pkg"].rsplit(" ", 1)[0].lower()
    return f.title.split(": ", 1)[0].lower() if f.source == "npm_audit" else None


def _fold_second_opinions(findings: list[RawFinding]) -> list[RawFinding]:
    semgrep = [f for f in findings if f.source == "semgrep"]
    leaks = [f for f in findings if f.source == "gitleaks"]
    audits = [f for f in findings if f.source in ("npm_audit", "pip_audit", "osv")]
    s1_ids: dict[int, tuple[RawFinding, list[str]]] = {}
    kept = []
    for f in findings:
        name = _SECOND_OPINION.get(f.source)
        match = name and next((s for s in semgrep if _repeats(f, s)), None)
        if match:
            _credit(match, f"_Also flagged by {name} ({f.title.split(' ', 1)[0]})._")
            continue
        # A Semgrep secret rule on a line Gitleaks already reported.
        if f.source == "semgrep" and ".secrets." in f".{f.title}.":
            match = next((g for g in leaks if (g.file_path or "").lower() == (f.file_path or "").lower()
                          and g.line_start is not None and f.line_start is not None
                          and abs(g.line_start - f.line_start) <= 1), None)
            if match:
                _credit(match, "_Also flagged by Semgrep._")
                continue
        # SentinelOne's vulnerable package that npm audit / pip-audit / OSV report from the same folder.
        if f.source == "s1_vuln" and (pkg := _package(f)):
            match = next((a for a in audits if _package(a) == pkg and _dir(a.file_path) == _dir(f.file_path)), None)
            if match:
                ident = _ADVISORY.match(f.title)
                s1_ids.setdefault(id(match), (match, []))[1].append(ident["id"] if ident else pkg)
                continue
        kept.append(f)
    for match, ids in s1_ids.values():
        _credit(match, f"_Also reported by SentinelOne ({', '.join(dict.fromkeys(ids))})._")
    return kept


_SEV = ["critical", "high", "medium", "low", "info"]
# "pyjwt 2.14.0: CVE-2026-1", "lodash 4.17.20: GHSA-xxxx" (pip-audit, OSV, SentinelOne, ...)
_ADVISORY = re.compile(r"^(?P<pkg>[\w@./:+-]+ [\w.+!~:-]+): (?P<id>[A-Z][A-Z0-9]+-[\w.:-]+)")
_DEP_SOURCES = {"pip_audit", "npm_audit", "osv", "s1_vuln"}
_MAX_LISTED = 30
# Checkov: "Resource: `X`."; SentinelOne IaC: "(resource: X)".
_RESOURCE = re.compile(r"Resource: `([^`]+)`|\(resource: ([^)]+)\)")
_CONFIG_HEAD = ("**Configuration checks:** best practices, not confirmed vulnerabilities. "
                "Check whether each matters for how this is deployed.")
_TOOL = {"checkov": "Checkov", "s1_iac": "SentinelOne"}


def _check_line(f: RawFinding) -> str:
    if f.source == "checkov":
        cid, _, name = f.title.partition(" ")
        return f"- **{cid}** ({f.severity}): {name}"
    return f"- **SentinelOne** ({f.severity}): {re.sub(r'^[A-Za-z]+ - ', '', f.title)}"


def _check_link(f: RawFinding) -> str | None:
    if f.source == "checkov" and (f.remediation or "").startswith("See "):
        return f"- {f.title.split(' ', 1)[0]}: {f.remediation[4:]}"
    if f.source == "s1_iac" and f.remediation:
        return f"- SentinelOne: {' '.join(f.remediation.split())[:300]}"
    return None


def _where(f: RawFinding) -> str:
    return f"`{f.file_path}:{f.line_start}`" if f.line_start else f"`{f.file_path}`"


def _group_key(f: RawFinding) -> tuple | None:
    """Findings that are really one issue: the same Semgrep rule anywhere in the repo,
    or several advisories for the same package version. Secrets stay one per finding."""
    if f.source in ("semgrep", "bandit"):
        return ("rule", f.source, f.title)
    if f.source == "npm_audit":     # the same advisory in several package.json folders
        return ("rule", f.source, f.title)
    if f.source in ("checkov", "s1_iac") and (res := _RESOURCE.search(f.description or "")):
        # Both tools name resources the same way ("AWS::S3::Bucket.Site"): one finding per resource.
        return ("resource", (f.file_path or "").lower(), res[1] or res[2])
    m = _ADVISORY.match(f.title)
    if m and f.source in _DEP_SOURCES:
        return ("pkg", f.source, m["pkg"].lower(), (f.file_path or "").lower())
    return None


def group_findings(findings: list[RawFinding]) -> list[RawFinding]:
    groups: dict[tuple, list[RawFinding]] = {}
    out: list[RawFinding | tuple] = []
    for f in findings:
        key = _group_key(f)
        if key is None:
            out.append(f)
        elif key in groups:
            groups[key].append(f)
        else:
            groups[key] = [f]
            out.append(key)          # placeholder keeps the group where it first appeared
    return [_merge(k, groups[k]) if isinstance(k, tuple) else k for k in out]


def _merge(key: tuple, items: list[RawFinding]) -> RawFinding:
    if len(items) == 1:
        return items[0]
    merged = _merge_group(key, items)
    credits = [ln for f in items for ln in (f.description or "").split("\n\n") if ln.startswith("_Also ")]
    for note in dict.fromkeys(credits):
        _credit(merged, note)
    return merged


def _merge_group(key: tuple, items: list[RawFinding]) -> RawFinding:
    items = sorted(items, key=lambda f: (_SEV.index(f.severity) if f.severity in _SEV else 9,
                                         f.file_path or "", f.line_start or 0))
    first = items[0]
    merged = dataclasses.replace(first)
    if key[0] == "pkg":
        pkg = _ADVISORY.match(first.title)["pkg"]
        merged.title = f"{pkg}: {len(items)} known vulnerabilities"
        lines = []
        for f in items:
            ident = _ADVISORY.match(f.title)["id"]
            summary = " ".join((f.description or "").split())[:240]
            lines.append(f"- **{ident}** ({f.severity}){': ' + summary if summary else ''}")
        merged.description = "\n".join(lines)
        fixes = list(dict.fromkeys(f.remediation for f in items if f.remediation))
        merged.remediation = "\n".join(f"- {r}" for r in fixes) if len(fixes) > 1 else (fixes[0] if fixes else None)
    elif key[0] == "resource":
        resource = key[2]
        tools = " and ".join(dict.fromkeys(_TOOL[f.source] for f in items))
        merged.title = f"{resource}: {len(items)} configuration checks failed"
        merged.line_start = min(f.line_start for f in items if f.line_start) if any(f.line_start for f in items) else None
        merged.line_end = max((f.line_end or f.line_start or 0) for f in items) or None
        checks = "\n".join(_check_line(f) for f in items)
        merged.description = f"{_CONFIG_HEAD}\n\n**Checks that failed for `{resource}`** ({tools}):\n{checks}"
        merged.remediation = "\n".join(link for f in items if (link := _check_link(f))) or None
    else:
        listed = "\n".join(f"- {_where(f)}" for f in items[:_MAX_LISTED])
        more = f"\n- …and {len(items) - _MAX_LISTED} more" if len(items) > _MAX_LISTED else ""
        merged.description = f"{first.description or ''}\n\n**Found in {len(items)} places:**\n{listed}{more}".strip()
    return merged


def synthesize(*source_lists: list[RawFinding]) -> list[dict]:
    """Merge all source lists, deduplicate, group repeats, and return Finding-column dicts."""
    all_findings: list[RawFinding] = []
    for lst in source_lists:
        all_findings.extend(lst)

    return [_to_dict(f) for f in group_findings(dedup_raw_findings(all_findings))]


def _to_dict(f: RawFinding) -> dict:
    return dataclasses.asdict(f)
