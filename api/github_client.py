import hashlib
import hmac
import logging

import httpx

logger = logging.getLogger(__name__)

_API = "https://api.github.com"
_CHECK_NAME = "Custos Security Review"


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
