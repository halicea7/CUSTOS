import asyncio
import logging
import tempfile
from pathlib import Path

import git

from config import settings

logger = logging.getLogger(__name__)


async def clone_repo(url: str, sha: str, base_dir: str) -> str:
    """Clone *url* into a fresh temp dir under *base_dir* and check out *sha*.

    Returns the absolute path to the cloned directory.
    Caller is responsible for shutil.rmtree after use.
    """
    Path(base_dir).mkdir(parents=True, exist_ok=True)
    auth_url = _inject_token(url)
    logger.info("Cloning %s @ %s", url, sha[:8])
    return await asyncio.to_thread(_clone_sync, auth_url, sha, base_dir)


def _inject_token(url: str) -> str:
    if settings.GITHUB_TOKEN and "https://github.com" in url:
        return url.replace(
            "https://github.com",
            f"https://{settings.GITHUB_TOKEN}@github.com",
        )
    return url


def _clone_sync(url: str, sha: str, base_dir: str) -> str:
    tmpdir = tempfile.mkdtemp(dir=base_dir, prefix="Custos_")
    repo = git.Repo.clone_from(url, tmpdir)
    try:
        repo.git.checkout(sha)
    except git.GitCommandError:
        # Shallow clone didn't carry the SHA; do a full fetch and retry.
        repo.git.fetch("--unshallow")
        repo.git.checkout(sha)
    logger.info("Cloned to %s", tmpdir)
    return tmpdir
