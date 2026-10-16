"""Optional scanners, each switchable in Settings → Analysis → Scanners.

- Bandit: Python-specific SAST (a second opinion next to Semgrep).
- OSV-Scanner: known vulnerabilities in every ecosystem's lockfiles (Go,
  Rust, Java, Ruby, PHP, poetry, yarn, pnpm...). pip-audit and npm audit
  still own requirements.txt and package-lock.json, so those are skipped here.
- Checkov: infrastructure as code (Dockerfiles, Kubernetes, Terraform,
  GitHub Actions...).

The scanned repo can't switch these off for itself: in-code suppressions
(`# nosec`) are ignored and each tool gets an empty config of ours instead of
any config file in the repo. Like the other runners, they never raise.
"""

import json
import logging
import re
import tempfile
from pathlib import Path

from worker.analysis.sast import RawFinding, _read_lines, _rel, _run
from worker.analysis.vetting import TEST_PATH, _cap

logger = logging.getLogger(__name__)

EXTRA_SCANNERS = ("bandit", "osv", "checkov")
_SKIP_GLOBS = ("node_modules", "vendor", "venv", ".venv", "site-packages", "dist", "build", "__pycache__")


def _test_code(f: RawFinding) -> RawFinding:
    if f.file_path and TEST_PATH.search(f.file_path):
        _cap(f, "low", "it's in test, benchmark or script code")
    return f


# ── Bandit ────────────────────────────────────────────────────────────────────

# Bandit rates severity and its confidence separately. Only a confident result
# is above low: medium/medium is mostly "/tmp in a default" or SQL from constants.
_BANDIT_SEV = {("HIGH", "HIGH"): "high", ("HIGH", "MEDIUM"): "medium", ("MEDIUM", "HIGH"): "medium"}


async def run_bandit(repo_path: str) -> list[RawFinding]:
    if not any(Path(repo_path).rglob("*.py")):
        return []
    with tempfile.TemporaryDirectory(prefix="custos-bandit-") as tmp:
        ini = Path(tmp) / "bandit.ini"
        ini.write_text("[bandit]\n")              # ours, so a .bandit file in the repo isn't used
        cmd = [
            "bandit", "-r", repo_path, "-f", "json", "-q",
            "--ini", str(ini), "--ignore-nosec",
            "--severity-level", "medium", "--confidence-level", "medium",
            "-x", ",".join(f"*/{d}/*" for d in _SKIP_GLOBS),
        ]
        rc, stdout, stderr = await _run(cmd, cwd=tmp)
    if rc not in (0, 1):
        logger.warning("bandit exited %d: %s", rc, stderr[:200])
        return []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning("bandit produced non-JSON output")
        return []

    findings = []
    for r in data.get("results", []):
        sev = _BANDIT_SEV.get((r.get("issue_severity", "").upper(), r.get("issue_confidence", "").upper()), "low")
        path = _rel(repo_path, r.get("filename", ""))
        lines = r.get("line_range") or [r.get("line_number")]
        start, end = r.get("line_number"), max(x for x in lines if x) if any(lines) else None
        cwe = (r.get("issue_cwe") or {}).get("id")
        findings.append(_test_code(RawFinding(
            source="bandit",
            severity=sev,
            title=f"{r.get('test_id', 'B000')} {r.get('test_name', 'bandit')}",
            description=f"{r.get('issue_text', '')}\n\nBandit confidence: {r.get('issue_confidence', '?').lower()}.",
            file_path=path,
            line_start=start,
            line_end=end,
            cwe=f"CWE-{cwe}" if cwe else None,
            code_snippet=_read_lines(repo_path, path, start, end, cap=20) if path else None,
            remediation=f"See {r['more_info']}" if r.get("more_info") else None,
        )))
    logger.info("bandit: %d findings", len(findings))
    return findings


# ── OSV-Scanner ───────────────────────────────────────────────────────────────

# pip-audit and npm audit report these already.
_COVERED = re.compile(r"(^|/)(requirements[^/]*\.txt|requirements/[^/]+\.txt|package-lock\.json|npm-shrinkwrap\.json)$")
_GHSA_SEV = {"CRITICAL": "critical", "HIGH": "high", "MODERATE": "medium", "MEDIUM": "medium", "LOW": "low"}


def _cvss_sev(score: str | None) -> str | None:
    try:
        n = float(score)
    except (TypeError, ValueError):
        return None
    return "critical" if n >= 9 else "high" if n >= 7 else "medium" if n >= 4 else "low" if n > 0 else None


def _fixed_versions(vuln: dict, name: str) -> list[str]:
    fixed = []
    for aff in vuln.get("affected", []):
        if (aff.get("package") or {}).get("name") not in (None, name):
            continue
        for rng in aff.get("ranges", []):
            fixed += [e["fixed"] for e in rng.get("events", []) if e.get("fixed")]
    return list(dict.fromkeys(fixed))


async def run_osv(repo_path: str) -> list[RawFinding]:
    with tempfile.TemporaryDirectory(prefix="custos-osv-") as tmp:
        config = Path(tmp) / "osv-scanner.toml"
        config.write_text("")                     # overrides any osv-scanner.toml (ignored vulns) in the repo
        cmd = ["osv-scanner", "scan", "source", "-r", "--format", "json", "--config", str(config), repo_path]
        rc, stdout, stderr = await _run(cmd, cwd=tmp)
    # 0: nothing found, 1: vulnerabilities, 128: no lockfiles in the repo.
    if rc == 128:
        return []
    if rc not in (0, 1):
        logger.warning("osv-scanner exited %d: %s", rc, stderr[:200])
        return []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning("osv-scanner produced non-JSON output")
        return []

    findings = []
    for res in data.get("results", []):
        manifest = _rel(repo_path, (res.get("source") or {}).get("path", ""))
        if not manifest or _COVERED.search(manifest):
            continue
        for pkg in res.get("packages", []):
            info = pkg.get("package") or {}
            name, version = info.get("name", "?"), info.get("version", "?")
            group_sev = {i: g.get("max_severity") for g in pkg.get("groups", []) for i in g.get("ids", [])}
            for vuln in pkg.get("vulnerabilities", []):
                vid = vuln.get("id", "OSV-unknown")
                sev = (_cvss_sev(group_sev.get(vid))
                       or _GHSA_SEV.get(str((vuln.get("database_specific") or {}).get("severity", "")).upper())
                       or "medium")
                aliases = ", ".join(a for a in vuln.get("aliases", []) if a != vid)
                summary = vuln.get("summary") or " ".join((vuln.get("details") or "").split())[:400]
                fixed = _fixed_versions(vuln, name)
                findings.append(RawFinding(
                    source="osv",
                    severity=sev,
                    title=f"{name} {version}: {vid}",
                    description=((f"Aliases: {aliases}\n\n" if aliases else "") + summary) or None,
                    remediation=f"Upgrade to {', '.join(fixed)}" if fixed else None,
                    file_path=manifest,
                ))
    logger.info("osv-scanner: %d findings", len(findings))
    return findings


# ── Checkov ───────────────────────────────────────────────────────────────────

_CHECKOV_FRAMEWORKS = ("dockerfile", "kubernetes", "helm", "terraform", "cloudformation", "github_actions")
# Without a Prisma Cloud account Checkov gives no severities. Most checks are
# hardening advice (low); these words mark the ones that open something up.
_CHECKOV_MEDIUM = re.compile(
    r"privileged|as root|root user|user for the container|public|0\.0\.0\.0|wildcard|\badmin\b|injection|unsecure|insecure|"
    r"write-all|credential|secret|unencrypted|not encrypted|plain ?text|http\b|ssl|tls", re.I)
# Reliability and operations checks, not security: health checks, dead-letter
# queues, concurrency limits, tracing.
_CHECKOV_NOT_SECURITY = {"CKV_DOCKER_2", "CKV_AWS_115", "CKV_AWS_116", "CKV_AWS_50", "CKV_AWS_73",
                         "CKV_AZURE_17", "CKV_K8S_8", "CKV_K8S_9"}
_CHECKOV_NOTE = ("**Checkov hardening check:** a configuration best practice, not a confirmed vulnerability. "
                 "Check whether it matters for how this is deployed.")


async def run_checkov(repo_path: str) -> list[RawFinding]:
    with tempfile.TemporaryDirectory(prefix="custos-checkov-") as tmp:
        # "--directory=PATH" as one argument: Checkov reads a .checkov.yaml from the folder only when
        # it's given as "-d PATH", and a repo's config could skip checks or load its own Python
        # checks (external-checks-dir). cwd and HOME are ours, so no config is read from there either.
        cmd = ["checkov", f"--directory={repo_path}", "-o", "json", "--quiet", "--compact", "--skip-download",
               "--framework", *_CHECKOV_FRAMEWORKS]
        rc, stdout, stderr = await _run(cmd, cwd=tmp, env={"HOME": tmp})
    if rc not in (0, 1):
        logger.warning("checkov exited %d: %s", rc, stderr[:200])
        return []
    try:
        data = json.loads(stdout) if stdout.strip() else []
    except json.JSONDecodeError:
        logger.warning("checkov produced non-JSON output")
        return []

    findings = []
    for report in data if isinstance(data, list) else [data]:
        for c in ((report or {}).get("results") or {}).get("failed_checks", []):
            if c.get("check_id") in _CHECKOV_NOT_SECURITY:
                continue
            path = (c.get("file_path") or c.get("repo_file_path") or "").lstrip("/")
            path = _rel(repo_path, path) if Path(path).is_absolute() else path
            rng = c.get("file_line_range") or [None, None]
            start, end = (rng[0] or None), (rng[-1] or None)
            name = c.get("check_name", "")
            findings.append(_test_code(RawFinding(
                source="checkov",
                severity="medium" if _CHECKOV_MEDIUM.search(name) else "low",
                title=f"{c.get('check_id', 'CKV')} {name}".strip(),
                description=f"{_CHECKOV_NOTE}\n\nResource: `{c.get('resource', '?')}`.",
                file_path=path or None,
                line_start=start,
                line_end=end,
                code_snippet=_read_lines(repo_path, path, start, end, cap=20) if path else None,
                remediation=f"See {c['guideline']}" if c.get("guideline") else None,
            )))
    logger.info("checkov: %d findings", len(findings))
    return findings


RUNNERS = {"bandit": run_bandit, "osv": run_osv, "checkov": run_checkov}
# (stage id, label, tool) for the self-scan progress view.
STAGES = {"bandit": ("bandit", "Python SAST", "bandit"),
          "osv": ("osv", "Dependency audit (all ecosystems)", "osv-scanner"),
          "checkov": ("checkov", "Infrastructure as code", "checkov")}
