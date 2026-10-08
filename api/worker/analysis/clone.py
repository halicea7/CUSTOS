"""Fetch a single commit of a repository into a fresh temp directory.

The GitHub token is passed to git as an HTTP Authorization header via
GIT_CONFIG_* environment variables. It never appears in the remote URL, in
``.git/config``, in the process argument list, or in error messages.
"""

import asyncio
import base64
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

_GIT_TIMEOUT_SECONDS = 300

# Anything that looks like a credential: GitHub tokens and userinfo in URLs.
_SECRET_PATTERNS = [
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "***"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "***"),
    (re.compile(r"(https?://)[^/@\s]+@"), r"\1***@"),
    (re.compile(r"(Authorization:\s*\w+\s+)\S+", re.IGNORECASE), r"\1***"),
]


def redact(text: str, *secrets: str) -> str:
    """Remove known secrets and anything credential-shaped from *text*."""
    for s in secrets:
        if s:
            text = text.replace(s, "***")
    for pat, repl in _SECRET_PATTERNS:
        text = pat.sub(repl, text)
    return text


class CloneError(RuntimeError):
    pass


_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


async def clone_repo(url: str, sha: str, base_dir: str, github_token: str = "") -> str:
    """Fetch *sha* from *url* into a new temp dir under *base_dir*.

    Uses a depth-1 fetch of the exact commit, so only one tree is downloaded.
    Returns the absolute path; the caller is responsible for removing it.
    """
    if not _SHA_RE.match(sha):
        raise CloneError(f"Refusing to fetch: {sha[:50]!r} is not a commit SHA")
    Path(base_dir).mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(dir=base_dir, prefix="Custos_")
    env = _git_env(github_token)
    logger.info("Fetching %s @ %s", url, sha[:8])
    try:
        await _git(["init", "--quiet"], tmpdir, env, github_token)
        await _git(["remote", "add", "origin", url], tmpdir, env, github_token)
        try:
            await _git(["fetch", "--quiet", "--depth", "1", "origin", sha], tmpdir, env, github_token)
        except CloneError:
            # Some servers refuse fetching an arbitrary SHA; fall back to a full fetch.
            logger.info("Direct SHA fetch refused; falling back to full fetch")
            await _git(["fetch", "--quiet", "origin"], tmpdir, env, github_token)
        await _git(["checkout", "--quiet", "--detach", sha], tmpdir, env, github_token)
    except BaseException:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    logger.info("Checked out to %s", tmpdir)
    return tmpdir


def _git_env(token: str) -> dict[str, str]:
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/bin/true",
        # Don't let a hostile repo run hooks or read the host's config.
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    configs = [("core.hooksPath", os.devnull), ("protocol.file.allow", "never")]
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        configs.append(("http.https://github.com/.extraheader", f"Authorization: Basic {basic}"))
    env["GIT_CONFIG_COUNT"] = str(len(configs))
    for i, (k, v) in enumerate(configs):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    return env


async def _git(args: list[str], cwd: str, env: dict[str, str], token: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=_GIT_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise CloneError(f"git {args[0]} timed out after {_GIT_TIMEOUT_SECONDS}s") from None
    if proc.returncode != 0:
        msg = redact(stderr.decode(errors="replace").strip(), token)
        raise CloneError(f"git {args[0]} failed ({proc.returncode}): {msg[:500]}")
