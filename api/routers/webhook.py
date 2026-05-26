import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db
from github_client import verify_github_signature, post_github_check
from models import Submission
from routers.settings import get_github_config_internal
from schemas import WebhookResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["webhook"])

_HANDLED_EVENTS = {"push", "pull_request"}
_HANDLED_PR_ACTIONS = {"opened", "synchronize"}


@router.post("/github", response_model=WebhookResponse, status_code=202)
async def github_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    payload_bytes = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")

    # HMAC validation must happen before any DB or queue interaction.
    webhook_secret, _ = await get_github_config_internal(db)
    if not verify_github_signature(payload_bytes, signature, webhook_secret):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid signature")

    event_type = request.headers.get("X-GitHub-Event", "")
    if event_type not in _HANDLED_EVENTS:
        return WebhookResponse(status="ignored")

    payload = json.loads(payload_bytes)

    if event_type == "pull_request" and payload.get("action") not in _HANDLED_PR_ACTIONS:
        return WebhookResponse(status="ignored")

    repo = payload["repository"]
    repo_full_name: str = repo["full_name"]
    repo_url: str = repo["clone_url"]

    if event_type == "push":
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
    redis = request.app.state.redis
    dedup_key = f"Custos:dedup:{repo_full_name}:{commit_sha}"
    is_new = await redis.set(dedup_key, "1", nx=True, ex=300)
    if not is_new:
        logger.info("Duplicate webhook for %s@%s — skipping", repo_full_name, commit_sha)
        return WebhookResponse(status="deduplicated")

    submission = Submission(
        repo_full_name=repo_full_name,
        repo_url=repo_url,
        commit_sha=commit_sha,
        branch=branch,
        submitter=submitter,
        event_type=event_type,
        pr_number=pr_number,
        status="pending",
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)

    submission_id = str(submission.id)

    arq_pool = request.app.state.arq_pool
    await arq_pool.enqueue_job("analyze_submission", submission_id)

    _, github_token = await get_github_config_internal(db)
    await post_github_check(repo=repo_full_name, sha=commit_sha, status="in_progress", token=github_token)

    logger.info(
        "Enqueued analysis for submission %s (%s@%s)", submission_id, repo_full_name, commit_sha
    )
    return WebhookResponse(status="accepted", submission_id=submission_id)
