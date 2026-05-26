import hmac
import hashlib
import logging
import httpx

logger = logging.getLogger(__name__)


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


async def post_github_check(
    repo: str,
    sha: str,
    status: str = "in_progress",
    conclusion: str | None = None,
    finding_count: int = 0,
    token: str = "",
) -> None:
    if not token:
        return

    url = f"https://api.github.com/repos/{repo}/check-runs"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body: dict = {
        "name": "Custos Security Review",
        "head_sha": sha,
        "status": status,
    }
    if conclusion:
        body["conclusion"] = conclusion
        body["output"] = {
            "title": "Custos Security Review",
            "summary": f"Found {finding_count} finding(s).",
        }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, headers=headers, json=body)
            response.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to post GitHub check for %s@%s: %s", repo, sha, exc)
