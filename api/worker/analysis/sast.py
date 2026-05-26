"""Async SAST tool runners.

Each runner returns a list of RawFinding dicts. They never raise — tool
absence or non-zero exit is logged and returns an empty list.
"""

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class RawFinding:
    source: str
    severity: str
    title: str
    description: Optional[str] = None
    file_path: Optional[str] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    cwe: Optional[str] = None
    code_snippet: Optional[str] = None
    remediation: Optional[str] = None
    llm_reasoning: Optional[str] = None


# ── helpers ───────────────────────────────────────────────────────────────────

async def _run(cmd: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
    except FileNotFoundError:
        logger.warning("Tool not found: %s", cmd[0])
        return 127, "", f"{cmd[0]}: command not found"
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")


_SEMGREP_SEVERITY = {
    "CRITICAL": "critical",
    "ERROR": "high",
    "WARNING": "medium",
    "INFO": "low",
}


# ── Semgrep ───────────────────────────────────────────────────────────────────

async def run_semgrep(repo_path: str) -> list[RawFinding]:
    cmd = ["semgrep", "scan", "--config=auto", "--json", "--quiet", repo_path]
    rc, stdout, stderr = await _run(cmd)
    # semgrep exits 1 when findings exist — that is normal.
    if rc not in (0, 1):
        logger.warning("semgrep exited %d: %s", rc, stderr[:200])
        return []

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning("semgrep produced non-JSON output")
        return []

    findings: list[RawFinding] = []
    for r in data.get("results", []):
        extra = r.get("extra", {})
        raw_sev = extra.get("severity", "INFO").upper()
        cwe_list: list[str] = extra.get("metadata", {}).get("cwe", [])
        # e.g. "CWE-89: SQL Injection" → "CWE-89"
        cwe = cwe_list[0].split(":")[0] if cwe_list else None
        findings.append(
            RawFinding(
                source="semgrep",
                severity=_SEMGREP_SEVERITY.get(raw_sev, "info"),
                title=r.get("check_id", "Unknown rule"),
                description=extra.get("message"),
                file_path=_rel(repo_path, r.get("path", "")),
                line_start=r.get("start", {}).get("line"),
                line_end=r.get("end", {}).get("line"),
                cwe=cwe,
                code_snippet=extra.get("lines"),
            )
        )
    logger.info("semgrep: %d findings", len(findings))
    return findings


# ── Gitleaks ──────────────────────────────────────────────────────────────────

async def run_gitleaks(repo_path: str) -> list[RawFinding]:
    cmd = [
        "gitleaks",
        "detect",
        f"--source={repo_path}",
        "--report-format=json",
        "--report-path=stdout",
        "--no-git",
    ]
    rc, stdout, stderr = await _run(cmd)
    if rc not in (0, 1):
        logger.warning("gitleaks exited %d: %s", rc, stderr[:200])
        return []

    try:
        leaks = json.loads(stdout) if stdout.strip() else []
    except json.JSONDecodeError:
        logger.warning("gitleaks produced non-JSON output")
        return []

    findings: list[RawFinding] = []
    for leak in leaks:
        # NEVER store the secret value — store only that one was found.
        findings.append(
            RawFinding(
                source="gitleaks",
                severity="high",
                title=f"Secret detected: {leak.get('RuleID', 'unknown')}",
                description=(
                    f"Rule '{leak.get('RuleID')}' matched in {leak.get('File')} "
                    f"at line {leak.get('StartLine')}. Secret value redacted."
                ),
                file_path=_rel(repo_path, leak.get("File", "")),
                line_start=leak.get("StartLine"),
                line_end=leak.get("EndLine"),
            )
        )
    logger.info("gitleaks: %d findings", len(findings))
    return findings


# ── pip-audit ─────────────────────────────────────────────────────────────────

async def run_dep_audit(repo_path: str) -> list[RawFinding]:
    findings: list[RawFinding] = []
    findings.extend(await _pip_audit(repo_path))
    findings.extend(await _npm_audit(repo_path))
    return findings


async def _pip_audit(repo_path: str) -> list[RawFinding]:
    req_paths: list[Path] = []
    root = Path(repo_path)
    for candidate in [root / "requirements.txt", *root.glob("requirements/*.txt")]:
        if candidate.is_file():
            req_paths.append(candidate)
    if not req_paths:
        return []

    findings: list[RawFinding] = []
    for req in req_paths:
        # Use the running interpreter so pip-audit is always found in the venv.
        cmd = [sys.executable, "-m", "pip_audit", "--requirement", str(req), "--format=json", "--no-deps"]
        rc, stdout, stderr = await _run(cmd)
        if rc not in (0, 1):
            logger.warning("pip-audit exited %d: %s", rc, stderr[:200])
            continue
        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            continue

        for dep in data.get("dependencies", []):
            for vuln in dep.get("vulns", []):
                aliases = ", ".join(vuln.get("aliases", []))
                findings.append(
                    RawFinding(
                        source="pip_audit",
                        severity="high",
                        title=f"{dep['name']} {dep['version']}: {vuln.get('id', '')}",
                        description=vuln.get("description"),
                        remediation=(
                            f"Upgrade to {', '.join(vuln.get('fix_versions', ['unknown']))}"
                            if vuln.get("fix_versions")
                            else None
                        ),
                        cwe=None,
                        file_path=str(req.relative_to(root)),
                    )
                )
    logger.info("pip-audit: %d findings", len(findings))
    return findings


_NPM_SEVERITY = {
    "critical": "critical",
    "high": "high",
    "moderate": "medium",
    "low": "low",
    "info": "info",
}


async def _npm_audit(repo_path: str) -> list[RawFinding]:
    if not (Path(repo_path) / "package.json").is_file():
        return []

    cmd = ["npm", "audit", "--json"]
    rc, stdout, stderr = await _run(cmd, cwd=repo_path)
    if rc not in (0, 1):
        logger.warning("npm audit exited %d: %s", rc, stderr[:200])
        return []

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return []

    findings: list[RawFinding] = []
    for name, vuln in data.get("vulnerabilities", {}).items():
        raw_sev = vuln.get("severity", "low")
        via = vuln.get("via", [])
        desc = next(
            (v.get("title") for v in via if isinstance(v, dict) and "title" in v),
            None,
        )
        findings.append(
            RawFinding(
                source="npm_audit",
                severity=_NPM_SEVERITY.get(raw_sev, "low"),
                title=f"{name}: {desc or raw_sev + ' severity vulnerability'}",
                description=desc,
                remediation="npm audit fix" if vuln.get("fixAvailable") else None,
                file_path="package.json",
            )
        )
    logger.info("npm audit: %d findings", len(findings))
    return findings


# ── util ──────────────────────────────────────────────────────────────────────

def _rel(repo_path: str, path: str) -> str | None:
    if not path:
        return None
    try:
        return str(Path(path).relative_to(repo_path))
    except ValueError:
        return path
