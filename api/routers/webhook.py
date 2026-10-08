import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from crypto import decrypt
from database import get_db
from github_client import verify_github_signature
from intake import claim_commit, queue_submission
from models import Repo
from schemas import WebhookResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])

_HANDLED_EVENTS = {"push", "pull_request"}
_HANDLED_PR_ACTIONS = {"opened", "synchronize"}


@router.post("/github", response_model=WebhookResponse, status_code=202)
async def github_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    payload_bytes = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")
    event_type = request.headers.get("X-GitHub-Event", "")

    # Minimal JSON parse to identify the repo — needed to look up its webhook secret.
    try:
        payload = json.loads(payload_bytes)
    except json.JSONDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON") from None

    repo_full_name: str = payload.get("repository", {}).get("full_name", "")
    if not repo_full_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing repository.full_name")

    # Read-only DB lookup to get the per-repo webhook secret — occurs before any write/queue op.
    result = await db.execute(select(Repo).where(Repo.repo_full_name == repo_full_name))
    repo_rec = result.scalar_one_or_none()
    webhook_secret = decrypt(repo_rec.webhook_secret_enc) if repo_rec else ""
    if not repo_rec or not verify_github_signature(payload_bytes, signature, webhook_secret):
        # Same response for unknown repos and bad signatures: don't disclose registrations.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid signature")
    if not repo_rec.enabled:
        return WebhookResponse(status="ignored")

    if event_type not in _HANDLED_EVENTS:
        return WebhookResponse(status="ignored")

    if event_type == "pull_request" and payload.get("action") not in _HANDLED_PR_ACTIONS:
        return WebhookResponse(status="ignored")

    repo = payload["repository"]
    repo_url: str = repo["clone_url"]

    if event_type == "push":
        ref = payload.get("ref", "")
        if payload.get("deleted") or set(payload.get("after", "")) == {"0"}:
            return WebhookResponse(status="ignored")
        if not ref.startswith("refs/heads/"):
            return WebhookResponse(status="ignored")  # tag pushes
        commit_sha: str = payload["after"]
        branch: str = payload.get("ref", "").replace("refs/heads/", "")
        submitter: str | None = payload.get("pusher", {}).get("name")
        pr_number: int | None = None
    else:
        pr = payload["pull_request"]
        commit_sha = pr["head"]["sha"]
        branch = pr["head"]["ref"]
        submitter = pr["user"]["login"]
        pr_number = payload["number"]

    # Redis dedup: prevent double-processing if GitHub retries the webhook.
    if not await claim_commit(request.app.state.redis, repo_full_name, commit_sha):
        logger.info("Duplicate webhook for %s@%s — skipping", repo_full_name, commit_sha)
        return WebhookResponse(status="deduplicated")

    # On failure the claim is released, so GitHub's redelivery can retry.
    submission = await queue_submission(
        db, request.app.state.redis, request.app.state.arq_pool, repo_rec,
        repo_url=repo_url, commit_sha=commit_sha, branch=branch,
        submitter=submitter, event_type=event_type, pr_number=pr_number,
    )
    return WebhookResponse(status="accepted", submission_id=str(submission.id))
