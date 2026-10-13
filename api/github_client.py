import hashlib
import hmac
import logging
from datetime import UTC, datetime

import httpx

logger = logging.getLogger(__name__)

_API = "https://api.github.com"
_CHECK_NAME = "Custos Security Review"
# GitHub sends this on every response to a request made with an expiring token.
_EXPIRY_HEADER = "github-authentication-token-expiration"


def verify_github_signature(payload: bytes, signature_header: str, secret: str = "") -> bool:
    if not secret:
        return False
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def post_github_check(
    repo: str,
    sha: str,
    status: str = "in_progress",
    conclusion: str | None = None,
    summary: str | None = None,
    token: str = "",
    check_run_id: int | None = None,
) -> int | None:
    """Create or update the Custos check run on *sha*.

    When *check_run_id* is given the existing run is updated (PATCH) instead of
    creating a new one, so each commit carries a single Custos check. Returns
    the check run id, or None if nothing was posted. Never raises.
    """
    if not token:
        return check_run_id

    body: dict = {"name": _CHECK_NAME, "status": status}
    if conclusion:
        body["conclusion"] = conclusion
        body["output"] = {"title": _CHECK_NAME, "summary": summary or ""}

    try:
        async with httpx.AsyncClient(timeout=10, headers=_headers(token)) as client:
            if check_run_id:
                resp = await client.patch(f"{_API}/repos/{repo}/check-runs/{check_run_id}", json=body)
            else:
                resp = await client.post(
                    f"{_API}/repos/{repo}/check-runs", json={**body, "head_sha": sha}
                )
            resp.raise_for_status()
            return resp.json().get("id", check_run_id)
    except Exception as exc:
        logger.warning("Failed to post GitHub check for %s@%s: %s", repo, sha[:8], exc)
        return check_run_id


# Open PRs looked at per "Check for updates"; the newest are returned first.
MAX_OPEN_PRS = 50


def token_expiry(headers) -> datetime | None:
    """When the token behind a GitHub response expires, or None if it never does."""
    raw = (headers.get(_EXPIRY_HEADER) or "").strip()
    if not raw:
        return None
    for fmt, naive_utc in (("%Y-%m-%d %H:%M:%S %z", False), ("%Y-%m-%d %H:%M:%S UTC", True)):
        try:
            parsed = datetime.strptime(raw, fmt)
        except ValueError:
            continue
        return parsed.replace(tzinfo=UTC) if naive_utc else parsed.astimezone(UTC)
    logger.warning("Unrecognised %s header: %r", _EXPIRY_HEADER, raw)
    return None


async def fetch_token_expiry(repo: str, token: str) -> datetime | None:
    """Best effort: ask GitHub when *token* expires (None if unknown or never)."""
    try:
        async with httpx.AsyncClient(timeout=8, headers=_headers(token)) as client:
            resp = await client.get(f"{_API}/repos/{repo}")
    except httpx.HTTPError:
        return None
    return token_expiry(resp.headers)


class ScanTargets(list):
    """list_scan_targets' result: the targets, plus when the token used expires."""
    token_expires_at: datetime | None = None


async def list_scan_targets(repo: str, token: str) -> ScanTargets:
    """Commits Custos would scan for *repo* now: its default branch head and open PR heads.

    Each target matches what the webhook would have queued: commit_sha, branch,
    submitter, event_type ("push" or "pull_request"), pr_number and repo_url.
    Raises httpx.HTTPError when GitHub can't be reached or refuses the token.
    """
    async with httpx.AsyncClient(timeout=15, headers=_headers(token)) as client:
        meta = await client.get(f"{_API}/repos/{repo}")
        meta.raise_for_status()
        expires_at = token_expiry(meta.headers)
        info = meta.json()
        default_branch, repo_url = info["default_branch"], info["clone_url"]

        head = await client.get(f"{_API}/repos/{repo}/commits/{default_branch}")
        head.raise_for_status()
        commit = head.json()
        targets = ScanTargets([{
            "commit_sha": commit["sha"],
            "branch": default_branch,
            "submitter": (commit.get("author") or {}).get("login")
            or (commit.get("commit", {}).get("author") or {}).get("name"),
            "event_type": "push",
            "pr_number": None,
            "repo_url": repo_url,
        }])
        targets.token_expires_at = expires_at

        pulls = await client.get(
            f"{_API}/repos/{repo}/pulls",
            params={"state": "open", "sort": "updated", "direction": "desc", "per_page": MAX_OPEN_PRS},
        )
        pulls.raise_for_status()
        for pr in pulls.json():
            targets.append({
                "commit_sha": pr["head"]["sha"],
                "branch": pr["head"]["ref"],
                "submitter": (pr.get("user") or {}).get("login"),
                "event_type": "pull_request",
                "pr_number": pr["number"],
                "repo_url": repo_url,
            })
    return targets
