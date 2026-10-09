"""SentinelOne CNS Shift Left CLI (s1-cns-cli) as an extra scanning layer.

Behaviour below is based on s1-shift-left-cli 1.0.4 (the version in
SentinelOne's pingsafe/s1-shift-left-cli:1.0.4 image):

- `config` writes the service-user token *in plaintext* to
  $HOME/.s1cns and a cache directory, so the CLI always runs with a private
  HOME owned by Custos, and `config` is only re-run when settings change.
- Errors exit with `--on-crash-exit-code` (default 0, i.e. indistinguishable
  from success), so we configure a distinctive non-zero code.
- Directory scans always exit 0; findings come only from the JSON output file.
- `--disable-sentry` keeps the CLI from reporting telemetry/crashes to Sentry.
- Secret findings include the raw secret (`detectedSecret`) unless masked; we
  never copy it. Secret *verification* logs in to third-party services with
  the found credentials, so it is off unless explicitly enabled.
- IaC scans download external Terraform modules by default; for untrusted
  repos we pass --skip-external-modules.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from config import settings
from worker.analysis.clone import redact
from worker.analysis.sast import RawFinding

logger = logging.getLogger(__name__)

SCANNERS = ("secret", "iac", "vuln")
SOURCE = {"secret": "s1_secret", "iac": "s1_iac", "vuln": "s1_vuln"}
_CRASH_EXIT_CODE = 97
_CONFIG_TIMEOUT = 300   # first run downloads the scanner binaries
_SCAN_TIMEOUT = 600
_SEVERITY = {"CRITICAL": "critical", "HIGH": "high", "MEDIUM": "medium", "LOW": "low"}


class S1Error(RuntimeError):
    """The SentinelOne layer failed; other scanners' results are unaffected."""


@dataclass
class S1Settings:
    console_url: str
    scope_type: str
    scope_id: str
    token: str = field(repr=False)
    # The console scanner policy. Without it, s1-shift-left-cli falls back to a
    # default policy that enables secret scanning only ("iac scan is disabled").
    policy_id: str = ""
    scanners: tuple[str, ...] = SCANNERS
    verify_secrets: bool = False
    publish: bool = False


@dataclass
class S1Result:
    findings: list[RawFinding] = field(default_factory=list)
    # Per-scanner failures when at least one scanner worked.
    errors: list[str] = field(default_factory=list)


@dataclass
class RepoMeta:
    """Needed only when publishing results to the SentinelOne console."""
    full_name: str
    branch: str | None = None


def _home() -> Path:
    return Path(settings.S1_HOME or Path.home() / ".cache" / "custos-s1cns")


def _cli() -> str:
    path = shutil.which(settings.S1_CNS_CLI)
    if not path:
        raise S1Error(
            f"{settings.S1_CNS_CLI} not found — install s1-shift-left-cli "
            "(included in the worker image; locally: ./custos setup --with-s1)"
        )
    return path


async def _exec(label: str, args: list[str], env: dict, timeout: int, token: str) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError as exc:
        raise S1Error(f"{args[0]} not found") from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise S1Error(f"s1-cns-cli {label} timed out after {timeout}s") from None
    # The CLI prints coloured log lines; strip ANSI codes and the token.
    text = re.sub(r"\x1b\[[0-9;]*m", "", out.decode(errors="replace"))
    return proc.returncode, redact(text, token)


def _last_lines(text: str, n: int = 3) -> str:
    lines = [" ".join(ln.split()) for ln in text.splitlines() if ln.strip()]
    # Prefer the CLI's ERROR lines over its WARNING/INFO chatter.
    errors = [ln for ln in lines if ln.startswith("ERROR")]
    return " | ".join((errors or lines)[-n:])[:500]


def _scan_error(scanner: str, out: str, context: str = "") -> str:
    if "Policy not found" in out:
        return (f"{scanner}: SentinelOne can't find the scanner policy ID in Settings → SentinelOne. "
                "Check it is the policy's ID (not its name) and that the policy was created at the "
                "scope Custos uses (scope type and ID), or clear the field to use the default policy")
    if f"{scanner} scan is disabled" in out:
        return (f"{scanner}: not enabled by the SentinelOne scanner policy. Without a policy ID "
                f"only secret scanning runs: set one in Settings → SentinelOne (and enable "
                f"{scanner} in that policy), or untick {scanner} there")
    return f"{scanner}: {context}{_last_lines(out) or 'no output'}"


async def _ensure_configured(cli: str, cfg: S1Settings, env: dict) -> None:
    home = Path(env["HOME"])
    cache_dir = home / "cache"
    fingerprint = hashlib.sha256(
        json.dumps([cfg.token, cfg.console_url, cfg.scope_type, cfg.scope_id, cfg.policy_id, _CRASH_EXIT_CODE]).encode()
    ).hexdigest()
    marker = home / ".custos-config"
    if marker.exists() and marker.read_text() == fingerprint and (cache_dir / "config.json").exists():
        return
    # The token is on argv for this one call: that is the CLI's only interface.
    rc, out = await _exec(
        "config",
        [cli, "--disable-sentry", "config",
         "--service-user-api-token", cfg.token,
         "--management-console-url", cfg.console_url,
         "--scope-type", cfg.scope_type,
         "--scope-id", cfg.scope_id,
         "--cache-directory", str(cache_dir),
         "--on-crash-exit-code", str(_CRASH_EXIT_CODE),
         *(["--policy-id", cfg.policy_id] if cfg.policy_id else [])],
        env, _CONFIG_TIMEOUT, cfg.token,
    )
    if rc != 0 or not (cache_dir / "config.json").exists():
        raise S1Error(f"s1-cns-cli config failed: {_last_lines(out) or f'exit {rc}'}")
    marker.write_text(fingerprint)
    marker.chmod(0o600)


def _scan_args(scanner: str, repo_path: str, cfg: S1Settings, repo: RepoMeta | None) -> list[str]:
    args = ["scan", scanner, "-d", repo_path, "--show-all-findings"]
    publish = cfg.publish and repo is not None and scanner in ("iac", "vuln")
    if scanner == "secret":
        if not cfg.verify_secrets:
            args.append("--disable-verification")
        # Secret publishing needs --pull-request/--pre-commit, which don't fit
        # single-commit review; always mask so raw values never touch disk.
        args.append("--mask-secret")
    if scanner == "iac":
        args.append("--skip-external-modules")
    if publish:
        args += ["--publish-result", "--provider", "GITHUB",
                 "--repo-full-name", repo.full_name,
                 "--repo-url", f"https://github.com/{repo.full_name}"]
        if scanner == "iac":
            args += ["--branch", repo.branch or "main"]
    return args


async def run_sentinelone(repo_path: str, cfg: S1Settings, repo: RepoMeta | None = None) -> S1Result:
    """Run the enabled S1 scanners on *repo_path*.

    Raises S1Error if the CLI can't be configured or every scanner failed;
    partial failures are reported in ``S1Result.errors``.
    """
    cli = _cli()
    home = _home()
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    env = {**os.environ, "HOME": str(home), "NO_COLOR": "1"}
    await _ensure_configured(cli, cfg, env)

    result = S1Result()
    with tempfile.TemporaryDirectory(dir=home, prefix="out-") as out_dir:
        for scanner in cfg.scanners:
            out_file = os.path.join(out_dir, f"{scanner}.json")
            rc, out = await _exec(
                f"scan {scanner}",
                [cli, "--disable-sentry", "--output-format", "JSON", "--output-file", out_file,
                 *_scan_args(scanner, repo_path, cfg, repo)],
                env, _SCAN_TIMEOUT, cfg.token,
            )
            if rc == _CRASH_EXIT_CODE:
                result.errors.append(_scan_error(scanner, out))
                continue
            if not os.path.exists(out_file) and rc != 0:
                # Exited abnormally without results (e.g. an uncaught error):
                # don't mistake that for a clean scan.
                result.errors.append(_scan_error(scanner, out, f"exited {rc}: "))
                continue
            if os.path.exists(out_file):  # exit 0 and no file = no findings
                try:
                    data = json.loads(Path(out_file).read_text() or "[]")
                except ValueError:
                    result.errors.append(f"{scanner}: unreadable output")
                    continue
                result.findings.extend(parse_results(scanner, data, repo_path))
    logger.info("SentinelOne: %d findings, %d scanner error(s)", len(result.findings), len(result.errors))
    if result.errors and len(result.errors) == len(cfg.scanners):
        raise S1Error("; ".join(result.errors))
    return result


# ── result parsing (s1-cns-json) ──────────────────────────────────────────────

def _sev(value) -> str:
    return _SEVERITY.get(str(value or "").upper(), "info")


def _rel(path, repo_path: str) -> str | None:
    if not path:
        return None
    try:
        return str(Path(path).resolve().relative_to(Path(repo_path).resolve()))
    except (ValueError, OSError):
        return str(path)


def _items(data) -> list[dict]:
    if isinstance(data, dict):
        data = data.get("findings", data.get("results", []))
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _int(v) -> int | None:
    try:
        return int(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def parse_results(scanner: str, data, repo_path: str) -> list[RawFinding]:
    out: list[RawFinding] = []
    for item in _items(data):
        if scanner == "secret":
            lines = sorted({
                int(line)
                for patch in ((item.get("detectedSecret") or {}).get("patches") or {}).values()
                if isinstance(patch, dict)
                for line in patch.get("lines") or []
                if str(line).isdigit()
            })
            verified = item.get("isSecretVerified")
            status = ("verified live" if verified else "not verified") if item.get("canVerify") else "not verifiable"
            out.append(RawFinding(
                source=SOURCE[scanner], severity=_sev(item.get("severity")),
                title=f"Secret detected: {item.get('title') or item.get('type') or 'unknown'}",
                description=(f"{item.get('type') or 'Secret'} found by SentinelOne ({status}). "
                             "Secret value redacted."),
                file_path=_rel(item.get("filePath"), repo_path),
                line_start=lines[0] if lines else None,
                line_end=lines[-1] if lines else None,
                # Never store detectedSecret: it can contain the raw value.
            ))
        elif scanner == "iac":
            desc = " ".join(x for x in (item.get("description"), item.get("issue_message")) if x)
            remediation = item.get("recommended_action") or None
            if item.get("info_link"):
                remediation = f"{remediation or ''}\n\nMore: {item['info_link']}".strip()
            out.append(RawFinding(
                source=SOURCE[scanner], severity=_sev(item.get("severity")),
                title=item.get("title") or item.get("plugin_id") or "IaC misconfiguration",
                description=(desc + (f" (resource: {item['block_name']})" if item.get("block_name") else "")) or None,
                file_path=_rel(item.get("file_path"), repo_path),
                line_start=_int(item.get("code_start_line")),
                line_end=_int(item.get("code_end_line")),
                code_snippet=item.get("code_block") or None,
                remediation=remediation,
            ))
        elif scanner == "vuln":
            paths = item.get("paths") or []
            fixed = item.get("fixedVersions") or ""
            remediation = f"Upgrade to {fixed}." if fixed else "No fixed version available yet."
            if item.get("link"):
                remediation += f" More: {item['link']}"
            out.append(RawFinding(
                source=SOURCE[scanner], severity=_sev(item.get("severity")),
                title=f"{item.get('package', '?')} {item.get('version', '')}: {item.get('id', '')}".strip(),
                description=item.get("description") or None,
                file_path=_rel(paths[0], repo_path) if paths else None,
                remediation=remediation,
            ))
    return out
