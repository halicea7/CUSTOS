"""CodeQL: deep, cross-file taint-tracking analysis, for languages it can extract
from source alone (Python, JavaScript/TypeScript, Ruby) — no build step, so this
keeps the same "never run repo-controlled code" rule as everything else. Compiled
languages need CodeQL's autobuild, which runs the repo's own build tooling, so
they're deliberately not supported here.

Optional (Settings → Analysis → CodeQL) and off by default: real CodeQL analysis
takes much longer than the rest of the scan, so it never shares the main scan's
time budget. When it's on, Custos queues it as its own follow-up job after a scan
finishes, with its own full job-timeout window, and adds whatever it finds to the
run afterward.

Licensing (not Custos's to enforce, but worth saying where it's read): GitHub's
CodeQL CLI is free for open-source code hosted on GitHub.com. Automated analysis
of private code needs a GitHub Advanced Security license — turning this setting
on for a private repo is the admin's call to make under that license, same as
registering a SentinelOne account is theirs.
"""

import json
import logging
import os
import re
import tempfile
from pathlib import Path

from worker.analysis.sast import RawFinding, _read_lines, _run
from worker.analysis.scanners import _cvss_sev, _test_code
from worker.analysis.vetting import _cap

logger = logging.getLogger(__name__)

# Extractable from source alone: no autobuild, so no repo-controlled build step.
LANGUAGES = {
    "python": (".py",),
    "javascript": (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"),
    "ruby": (".rb",),
}
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "vendor", "dist", "build"}
_DB_TIMEOUT_SECONDS = 1800   # per language: database create + analyze
_CWE = re.compile(r"external/cwe/cwe-(\d+)", re.I)
_FOOTNOTE = re.compile(r"\[([^\]]+)\]\(\d+\)")   # SARIF's "[text](1)" refers to a code-flow step


def languages_present(repo_path: str) -> list[str]:
    """Which of LANGUAGES this repo actually has source files for."""
    root = Path(repo_path)
    found = []
    for lang, exts in LANGUAGES.items():
        for _dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
            if any(Path(f).suffix.lower() in exts for f in filenames):
                found.append(lang)
                break
    return found


def _clean(text: str) -> str:
    return " ".join(_FOOTNOTE.sub(r"\1", text or "").split())


def _cwe_of(rule_props: dict) -> str | None:
    m = _CWE.search(" ".join(rule_props.get("tags") or []))
    return f"CWE-{m.group(1)}" if m else None


def _flow_summary(result: dict) -> str:
    """Where a dataflow finding's tainted value enters, if CodeQL traced one."""
    flows = result.get("codeFlows") or []
    locs = ((flows[0].get("threadFlows") or [{}])[0].get("locations") or []) if flows else []
    if not locs:
        return ""
    loc = (locs[0].get("location") or {}).get("physicalLocation") or {}
    uri = (loc.get("artifactLocation") or {}).get("uri")
    line = (loc.get("region") or {}).get("startLine")
    return f"Source: `{uri}:{line}`." if uri and line else ""


def _parse_sarif(data: dict, repo_path: str, language: str) -> list[RawFinding]:
    run = (data.get("runs") or [{}])[0]
    rules = {r["id"]: r for r in (run.get("tool", {}).get("driver", {}) or {}).get("rules", [])}
    out = []
    for result in run.get("results") or []:
        rule_id = result.get("ruleId")
        rule = rules.get(rule_id, {})
        props = rule.get("properties") or {}
        loc = ((result.get("locations") or [{}])[0]).get("physicalLocation") or {}
        path = (loc.get("artifactLocation") or {}).get("uri")
        region = loc.get("region") or {}
        start = region.get("startLine")
        if not path or not start:
            continue   # nowhere to point an analyst at
        end = region.get("endLine") or start
        desc = _clean((result.get("message") or {}).get("text"))
        flow = _flow_summary(result)
        f = RawFinding(
            source="codeql",
            severity=_cvss_sev(props.get("security-severity")) or "medium",
            title=f"{rule_id} {props.get('name', '')}".strip(),
            description=f"{desc}{(' ' + flow) if flow else ''}".strip(),
            file_path=path,
            line_start=start,
            line_end=end,
            cwe=_cwe_of(props),
            code_snippet=_read_lines(repo_path, path, start, end, cap=20),
        )
        if props.get("precision") == "low":   # a guess, not a confident match: don't let it rate above medium
            _cap(f, "medium", "CodeQL itself rates this query's precision as low")
        out.append(_test_code(f))
    logger.info("codeql (%s): %d findings", language, len(out))
    return out


async def _scan_language(repo_path: str, language: str) -> list[RawFinding]:
    with tempfile.TemporaryDirectory(prefix=f"custos-codeql-{language}-") as tmp:
        db = f"{tmp}/db"
        sarif = f"{tmp}/results.sarif"
        rc, out, err = await _run(
            ["codeql", "database", "create", db, f"--language={language}",
             f"--source-root={repo_path}", "--overwrite"],
            timeout=_DB_TIMEOUT_SECONDS,
        )
        if rc != 0:
            logger.warning("codeql database create (%s) exited %d: %s", language, rc, (err or out)[-300:])
            return []
        rc, out, err = await _run(
            ["codeql", "database", "analyze", db, f"{language}-security-extended.qls",
             "--format=sarif-latest", f"--output={sarif}", "--threads=0"],
            timeout=_DB_TIMEOUT_SECONDS,
        )
        if rc != 0 or not Path(sarif).is_file():
            logger.warning("codeql database analyze (%s) exited %d: %s", language, rc, (err or out)[-300:])
            return []
        try:
            data = json.loads(Path(sarif).read_text())
        except (OSError, ValueError):
            logger.warning("codeql (%s) produced unreadable SARIF", language)
            return []
    return _parse_sarif(data, repo_path, language)


async def run_codeql(repo_path: str, languages: list[str] | None = None) -> list[RawFinding]:
    """Run CodeQL for every requested language the repo actually has (default: all
    of LANGUAGES). Best effort per language: one failing or timing out doesn't lose
    the others. Known gap: these findings arrive in their own later pass, so they
    aren't folded into a matching Semgrep/Bandit finding at the same line the way
    those two are folded into each other — a real SSRF might appear once under
    Semgrep's rule and again under CodeQL's.
    """
    wanted = [lang for lang in (languages or LANGUAGES) if lang in LANGUAGES]
    present = set(languages_present(repo_path))
    findings: list[RawFinding] = []
    for lang in wanted:
        if lang not in present:
            continue
        findings.extend(await _scan_language(repo_path, lang))
    return findings
