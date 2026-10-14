"""Async SAST tool runners.

Each runner returns a list of RawFinding dicts. They never raise — tool
absence or non-zero exit is logged and returns an empty list.
"""

import asyncio
import json
import logging
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

_TOOL_TIMEOUT_SECONDS = 300


@dataclass
class RawFinding:
    source: str
    severity: str
    title: str
    description: str | None = None
    file_path: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    cwe: str | None = None
    code_snippet: str | None = None
    remediation: str | None = None
    llm_reasoning: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────────

async def _run(
    cmd: list[str], cwd: str | None = None, timeout: int = _TOOL_TIMEOUT_SECONDS
) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
    except FileNotFoundError:
        logger.warning("Tool not found: %s", cmd[0])
        return 127, "", f"{cmd[0]}: command not found"
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        logger.warning("%s timed out after %ds", cmd[0], timeout)
        return 124, "", f"{cmd[0]}: timed out"
    return proc.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")


_SEMGREP_SEVERITY = {
    "CRITICAL": "critical",
    "ERROR": "high",
    "WARNING": "medium",
    "INFO": "low",
}


# ── Semgrep ───────────────────────────────────────────────────────────────────

# Registry rule ids start with the language they were written for. A rule run
# against a file of another language (e.g. a Java/JSF template rule matching
# plain HTML) is noise: drop it. Languages not listed here are never dropped.
_RULE_EXTENSIONS = {
    "python": {".py", ".pyi"},
    "java": {".java", ".jsp", ".jspx", ".jsf", ".xhtml"},
    "kotlin": {".kt", ".kts"},
    "javascript": {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".html", ".htm"},
    "typescript": {".ts", ".tsx", ".js", ".jsx", ".vue"},
    "go": {".go"},
    "ruby": {".rb", ".erb"},
    "php": {".php", ".phtml"},
    "csharp": {".cs", ".cshtml", ".razor"},
    "rust": {".rs"},
    "scala": {".scala"},
    "swift": {".swift"},
    "c": {".c", ".h", ".cc", ".cpp", ".hpp"},
}
_AUDIT_NOTE = ("**Semgrep audit rule:** a pattern worth a look, not a confirmed vulnerability. "
               "Custos reports these as low; check whether untrusted input actually reaches it.")


def _language_mismatch(rule_id: str, path: str) -> bool:
    exts = _RULE_EXTENSIONS.get(rule_id.split(".", 1)[0].lower())
    return bool(exts) and Path(path).suffix.lower() not in exts


# Semgrep's "lines" says "requires login" unless signed in to its registry, so
# Custos reads the matched lines from the checkout itself.
_SNIPPET_MAX_LINES = 20
_PLACEHOLDER = "requires login"
# A pipe into a shell: "| sh", "| bash", "|sudo bash", ... (not "| python3").
_PIPE_TO_SHELL = re.compile(r"\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b")


def _read_lines(repo_path: str, rel: str, start: int | None, end: int | None, cap: int) -> str | None:
    if not start:
        return None
    path = (Path(repo_path) / rel).resolve()
    if not path.is_relative_to(Path(repo_path).resolve()) or not path.is_file():
        return None
    try:
        lines = path.read_text(errors="replace").split("\n")
    except OSError:
        return None
    last = min(end or start, start + cap - 1, len(lines))
    return "\n".join(lines[start - 1:last]) or None


def _curl_pipe_false_alarm(rule_id: str, lines: str | None) -> bool:
    """The GitHub-Actions curl-pipe-shell rule fires on a `run: |` block that merely
    contains curl. Keep it only when the matched lines really pipe into a shell."""
    return "curl-pipe" in rule_id and lines is not None and not _PIPE_TO_SHELL.search(lines)


def _is_audit_rule(rule_id: str) -> bool:
    """Registry 'audit' rules flag risky APIs (text(), shell=True, ...) without proving a bug."""
    return ".audit." in f".{rule_id}."

async def run_semgrep(repo_path: str) -> list[RawFinding]:
    # --config=auto requires sending metrics to semgrep.dev, so use explicit
    # rulesets (registry names or local paths) and keep metrics off.
    configs = [f"--config={c.strip()}" for c in settings.SEMGREP_CONFIG.split(",") if c.strip()]
    cmd = [
        "semgrep", "scan", *configs,
        "--json", "--quiet",
        "--metrics=off", "--disable-version-check",
        "--timeout=30", "--max-target-bytes=1000000",
        repo_path,
    ]
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
    skipped = 0
    for r in data.get("results", []):
        extra = r.get("extra", {})
        rule_id = r.get("check_id", "Unknown rule")
        path = _rel(repo_path, r.get("path", ""))
        if _language_mismatch(rule_id, path):
            skipped += 1
            continue
        start, end = r.get("start", {}).get("line"), r.get("end", {}).get("line")
        lines = _read_lines(repo_path, path, start, end, cap=200)
        if _curl_pipe_false_alarm(rule_id, lines):
            skipped += 1
            continue
        snippet = extra.get("lines")
        if not snippet or snippet.strip() == _PLACEHOLDER:
            snippet = "\n".join((lines or "").split("\n")[:_SNIPPET_MAX_LINES]) or None
        raw_sev = extra.get("severity", "INFO").upper()
        severity = _SEMGREP_SEVERITY.get(raw_sev, "info")
        message = extra.get("message")
        if _is_audit_rule(rule_id) and severity in ("critical", "high", "medium"):
            severity = "low"
            message = f"{_AUDIT_NOTE}\n\n{message}" if message else _AUDIT_NOTE
        cwe_list: list[str] = extra.get("metadata", {}).get("cwe", [])
        # e.g. "CWE-89: SQL Injection" → "CWE-89"
        cwe = cwe_list[0].split(":")[0] if cwe_list else None
        findings.append(
            RawFinding(
                source="semgrep",
                severity=severity,
                title=rule_id,
                description=message,
                file_path=path,
                line_start=start,
                line_end=end,
                cwe=cwe,
                code_snippet=snippet,
            )
        )
    logger.info("semgrep: %d findings%s", len(findings),
                f" ({skipped} skipped: other-language rules or false curl-pipe matches)" if skipped else "")
    return findings


# ── Gitleaks ──────────────────────────────────────────────────────────────────

async def run_gitleaks(repo_path: str) -> list[RawFinding]:
    # The report goes to a private temp file (gitleaks treats "stdout" as a
    # filename), and --redact keeps secret values out of it altogether.
    with tempfile.TemporaryDirectory(prefix="custos-gitleaks-") as tmp:
        report = Path(tmp) / "report.json"
        cmd = [
            "gitleaks",
            "detect",
            f"--source={repo_path}",
            "--report-format=json",
            f"--report-path={report}",
            "--redact",
            "--no-git",
            "--no-banner",
        ]
        rc, _stdout, stderr = await _run(cmd, cwd=tmp)
        if rc not in (0, 1):
            logger.warning("gitleaks exited %d: %s", rc, stderr[:200])
            return []
        raw = report.read_text() if report.is_file() else ""

    try:
        leaks = json.loads(raw) if raw.strip() else []
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


# ── dependency audits ─────────────────────────────────────────────────────────

# Manifests often live in subfolders (api/requirements.txt, web/package.json).
_MANIFEST_MAX_DEPTH = 4
_MANIFEST_MAX_DIRS = 20
_SKIP_DIRS = {"node_modules", "vendor", "venv", "env", "site-packages", "dist", "build", "__pycache__"}


def _manifest_dirs(root: Path, has_manifest) -> list[Path]:
    """Directories under *root* (root included) for which has_manifest(dir) is true."""
    found: list[Path] = []
    for dirpath, dirnames, _ in os.walk(root):  # does not follow symlinked dirs
        here = Path(dirpath)
        depth = len(here.relative_to(root).parts)
        dirnames[:] = sorted(
            d for d in dirnames
            if depth < _MANIFEST_MAX_DEPTH and not d.startswith(".") and d not in _SKIP_DIRS
        )
        if has_manifest(here):
            found.append(here)
            if len(found) >= _MANIFEST_MAX_DIRS:
                logger.warning("dependency audit: more than %d manifest folders, skipping the rest",
                               _MANIFEST_MAX_DIRS)
                break
    return found


def _is_file(p: Path) -> bool:
    # Never follow a symlink out of the checkout.
    return p.is_file() and not p.is_symlink()


async def run_dep_audit(repo_path: str) -> list[RawFinding]:
    findings: list[RawFinding] = []
    findings.extend(await _pip_audit(repo_path))
    findings.extend(await _npm_audit(repo_path))
    return findings


def _requirement_files(root: Path) -> list[Path]:
    def in_dir(d: Path) -> list[Path]:
        return [c for c in [d / "requirements.txt", *sorted(d.glob("requirements/*.txt"))] if _is_file(c)]
    return [req for d in _manifest_dirs(root, lambda d: bool(in_dir(d))) for req in in_dir(d)]


async def _pip_audit(repo_path: str) -> list[RawFinding]:
    root = Path(repo_path)
    req_paths = _requirement_files(root)
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
                        description=(
                            (f"Aliases: {aliases}\n\n" if aliases else "") + (vuln.get("description") or "")
                        ) or None,
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


def _npm_lock(d: Path) -> bool:
    # npm audit needs a lockfile; workspace members share the root's.
    return _is_file(d / "package.json") and (
        _is_file(d / "package-lock.json") or _is_file(d / "npm-shrinkwrap.json"))


async def _npm_audit(repo_path: str) -> list[RawFinding]:
    root = Path(repo_path)
    findings: list[RawFinding] = []
    for pkg_dir in _manifest_dirs(root, _npm_lock):
        findings.extend(await _npm_audit_dir(pkg_dir, str((pkg_dir / "package.json").relative_to(root))))
    return findings


# Listed as devDependencies but packaged into what users run.
_SHIPPED_DEV_PACKAGES = {"electron", "electron-nightly", "nw"}
_MAX_ADVISORIES = 25


def _lock_packages(pkg_dir: Path) -> dict:
    """The lockfile's "packages" map (node_modules path → metadata), or {}."""
    for name in ("package-lock.json", "npm-shrinkwrap.json"):
        lock = pkg_dir / name
        if _is_file(lock):
            try:
                packages = json.loads(lock.read_text()).get("packages")
            except (OSError, ValueError, AttributeError):
                return {}
            return packages if isinstance(packages, dict) else {}
    return {}


def _dev_only(nodes, lock: dict) -> bool:
    """True if every installed copy of the package is marked dev in the lockfile."""
    entries = [lock.get(n) for n in nodes or []]
    return bool(entries) and all(isinstance(e, dict) and e.get("dev") for e in entries)


def _installed_version(nodes, lock: dict) -> str | None:
    versions = sorted({e["version"] for n in nodes or [] if isinstance(e := lock.get(n), dict) and e.get("version")})
    return ", ".join(versions) or None


def _npm_fix(fix) -> str | None:
    if isinstance(fix, dict) and fix.get("name"):
        major = " (a major version: check for breaking changes)" if fix.get("isSemVerMajor") else ""
        return f"Upgrade `{fix['name']}` to {fix.get('version', 'a fixed version')}{major}, or run `npm audit fix`."
    return "Run `npm audit fix`." if fix else None


async def _npm_audit_dir(pkg_dir: Path, manifest: str) -> list[RawFinding]:
    # Force the public registry: a hostile repo's .npmrc could otherwise
    # redirect the audit request (and its lockfile) to an attacker's server.
    cmd = ["npm", "audit", "--json", "--registry=https://registry.npmjs.org/"]
    rc, stdout, stderr = await _run(cmd, cwd=str(pkg_dir))
    if rc not in (0, 1):
        logger.warning("npm audit (%s) exited %d: %s", manifest, rc, stderr[:200])
        return []

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return []

    lock = _lock_packages(pkg_dir)
    findings: list[RawFinding] = []
    for name, vuln in data.get("vulnerabilities", {}).items():
        advisories = [v for v in vuln.get("via", []) if isinstance(v, dict)]
        if not advisories:
            # Only vulnerable because a dependency is; that package has its own finding.
            continue
        severity = _NPM_SEVERITY.get(vuln.get("severity", "low"), "low")
        lines = []
        for a in advisories[:_MAX_ADVISORIES]:
            ident = (a.get("url") or "").rstrip("/").rsplit("/", 1)[-1] or str(a.get("source") or "")
            lines.append(f"- **{ident}** ({_NPM_SEVERITY.get(a.get('severity'), 'low')}): {a.get('title') or 'advisory'}")
        if len(advisories) > _MAX_ADVISORIES:
            lines.append(f"- …and {len(advisories) - _MAX_ADVISORIES} more")
        notes = []
        version = _installed_version(vuln.get("nodes"), lock)
        if version:
            notes.append(f"Installed: `{name}@{version}`.")
        effects = vuln.get("effects") or []
        if effects:
            notes.append("Pulled in by: " + ", ".join(f"`{e}`" for e in effects[:10])
                         + (f" and {len(effects) - 10} more" if len(effects) > 10 else "") + ".")
        if name not in _SHIPPED_DEV_PACKAGES and _dev_only(vuln.get("nodes"), lock) and severity in (
                "critical", "high", "medium"):
            notes.append(f"_Custos lowered this from **{severity}** to **low**: it's only a dev dependency "
                         "(build, test or tooling), not shipped with the app._")
            severity = "low"
        cwes = next((a["cwe"] for a in advisories if a.get("cwe")), None)
        findings.append(
            RawFinding(
                source="npm_audit",
                severity=severity,
                # Unchanged format: earlier false-positive decisions are matched by title.
                title=f"{name}: {advisories[0].get('title') or vuln.get('severity', 'low') + ' severity vulnerability'}",
                description="\n".join(lines) + ("\n\n" + " ".join(notes) if notes else ""),
                cwe=cwes[0] if isinstance(cwes, list) and cwes else None,
                remediation=_npm_fix(vuln.get("fixAvailable")),
                file_path=manifest,
            )
        )
    logger.info("npm audit (%s): %d findings", manifest, len(findings))
    return findings


# ── util ──────────────────────────────────────────────────────────────────────

def _rel(repo_path: str, path: str) -> str | None:
    if not path:
        return None
    try:
        return str(Path(path).relative_to(repo_path))
    except ValueError:
        return path
