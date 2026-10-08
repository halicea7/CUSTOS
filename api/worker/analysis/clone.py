import asyncio
import base64
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import git

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class CloneError(RuntimeError):
    """Clone failure with a message that is safe to store and show in the UI."""


async def clone_repo(url: str, sha: str, base_dir: str, github_token: str = "") -> str:
    """Fetch only commit *sha* of *url* into a fresh temp dir under *base_dir*.

    Returns the absolute path to the checked-out directory.
    Caller is responsible for shutil.rmtree after use.
    """
    if not _SHA_RE.match(sha):
        raise CloneError(f"Refusing to clone: invalid commit SHA {sha!r}")
    logger.info("Cloning %s @ %s", url, sha[:8])
    return await asyncio.to_thread(_clone_sync, url, sha, base_dir, github_token)


def _auth_config(url: str, token: str) -> list[str]:
    """git -c args that authenticate to GitHub for this command only.

    The token is passed as a header rather than embedded in the remote URL, so
    it is never written to .git/config inside the (untrusted) checkout.
    """
    if not token or urlparse(url).hostname != "github.com":
        return []
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return ["-c", f"http.extraHeader=Authorization: Basic {basic}"]


def _clone_sync(url: str, sha: str, base_dir: str, token: str) -> str:
    Path(base_dir).mkdir(parents=True, exist_ok=True)
    tmpdir = tempfile.mkdtemp(dir=base_dir, prefix="Custos_")
    auth = _auth_config(url, token)
    g = git.Git(tmpdir)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    def run(*args: str) -> None:
        try:
            g.execute(["git", *auth, *args], env=env)
        except git.GitCommandError as exc:
            # exc's str() includes the full command line — i.e. the auth
            # header. Only surface git's stderr.
            stderr = (exc.stderr or "").strip()
            raise CloneError(f"git {args[0]} failed: {stderr[-500:]}") from None

    try:
        run("init", "--quiet")
        run("remote", "add", "origin", url)
        try:
            # Shallow fetch of exactly the commit under review.
            run("fetch", "--quiet", "--depth=1", "origin", sha)
        except CloneError:
            # Server refused fetch-by-SHA; fall back to a full fetch.
            run("fetch", "--quiet", "origin")
        run("checkout", "--quiet", "--detach", sha)
    except BaseException:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise
    logger.info("Cloned to %s", tmpdir)
    return tmpdir
