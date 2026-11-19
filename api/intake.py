"""Queue commits for analysis.

Shared by the GitHub webhook, the "Check for updates" button and the
scheduled check, so every path creates identical submissions. Callers pass
Redis and the ARQ pool: app.state in the API, ctx["redis"] in the worker.
"""
import logging
from datetime import UTC, datetime

from sqlalchemy import select

from crypto import decrypt
from enums import SubmissionStatus
from github_client import list_scan_targets, post_github_check
from models import Repo, Submission

logger = logging.getLogger(__name__)


def dedup_key(repo_full_name: str, commit_sha: str) -> str:
    return f"Custos:dedup:{repo_full_name}:{commit_sha}"


async def claim_commit(redis, repo_full_name: str, commit_sha: str) -> bool:
    """True if this caller may queue the commit (no one else did in the last 5 minutes)."""
    return bool(await redis.set(dedup_key(repo_full_name, commit_sha), "1", nx=True, ex=300))


def _rescan_claim_key(repo_full_name: str, commit_sha: str) -> str:
    return f"Custos:rescan-claim:{repo_full_name}:{commit_sha}"


async def claim_rescan(redis, repo_full_name: str, commit_sha: str) -> bool:
    """True if this caller may force a rescan (no one did in the last 30 seconds).

    Deliberately separate from claim_commit/dedup_key: a forced rescan is for a
    commit that's *already* been scanned, so it must not be blocked by the
    5-minute claim that scan left behind. This only guards against the same
    "Scan now" click firing twice.
    """
    return bool(await redis.set(_rescan_claim_key(repo_full_name, commit_sha), "1", nx=True, ex=30))


async def queue_submission(
    db,
    redis,
    arq_pool,
    repo_rec: Repo,
    *,
    repo_url: str,
    commit_sha: str,
    branch: str | None,
    submitter: str | None,
    event_type: str,
    pr_number: int | None,
) -> Submission:
    """Create the submission, post a queued GitHub check and enqueue the analysis.

    On failure the dedup claim is released so the commit can be retried.
    """
    try:
        submission = Submission(
            repo_full_name=repo_rec.repo_full_name,
            repo_url=repo_url,
            commit_sha=commit_sha,
            branch=branch,
            submitter=submitter,
            event_type=event_type,
            pr_number=pr_number,
            status=SubmissionStatus.PENDING.value,
        )
        db.add(submission)
        repo_rec.last_push_at = datetime.now(UTC)
        await db.commit()

        github_token = decrypt(repo_rec.github_token_enc)
        submission.check_run_id = await post_github_check(
            repo=repo_rec.repo_full_name, sha=commit_sha, status="queued", token=github_token
        )
        await db.commit()

        await arq_pool.enqueue_job("analyze_submission", str(submission.id))
    except Exception:
        await redis.delete(dedup_key(repo_rec.repo_full_name, commit_sha))
        raise

    logger.info(
        "Enqueued analysis for submission %s (%s@%s)", submission.id, repo_rec.repo_full_name, commit_sha
    )
    return submission


async def check_repo_for_updates(db, redis, arq_pool, repo_rec: Repo) -> dict:
    """Queue the head of one branch (the default branch, or the repo's tracked
    ref if it has one) and open PR heads that haven't been scanned yet.

    Outbound calls only, so it works where GitHub can't reach Custos. Commits
    already submitted (by any path) are skipped. Raises httpx.HTTPError if
    GitHub can't be reached, refuses the token, or the tracked ref is gone.
    """
    targets = await list_scan_targets(
        repo_rec.repo_full_name, decrypt(repo_rec.github_token_enc), ref=repo_rec.tracked_ref
    )
    repo_rec.token_expires_at = targets.token_expires_at
    shas = {t["commit_sha"] for t in targets}
    seen = set((await db.execute(
        select(Submission.commit_sha).where(
            Submission.repo_full_name == repo_rec.repo_full_name, Submission.commit_sha.in_(shas)
        )
    )).scalars())

    queued: list[dict] = []
    for target in targets:
        sha = target["commit_sha"]
        if sha in seen:
            continue
        seen.add(sha)  # a PR whose head is also the default branch's head
        if not await claim_commit(redis, repo_rec.repo_full_name, sha):
            continue  # being queued right now by the webhook or another check
        submission = await queue_submission(db, redis, arq_pool, repo_rec, **target)
        queued.append({
            "submission_id": str(submission.id), "commit_sha": sha,
            "branch": target["branch"], "pr_number": target["pr_number"],
        })

    repo_rec.last_checked_at = datetime.now(UTC)
    await db.commit()
    logger.info(
        "Checked %s for updates: %d queued, %d already scanned",
        repo_rec.repo_full_name, len(queued), len(targets) - len(queued),
    )
    return {"queued": queued, "already_scanned": len(targets) - len(queued)}


async def rescan_repo_head(db, redis, arq_pool, repo_rec: Repo) -> dict:
    """Force a fresh scan of just the tracked ref's (or default branch's) current
    head, even if that commit was already scanned — e.g. after turning on a new
    scanner, to see it run without waiting for a new commit.

    Deliberately doesn't touch open PRs: re-queuing all of them on every click
    would repeat the exact PR-stampede slowdown a big repo like Autolab already
    hit once. "Check for updates" is still the way to catch up on those.
    """
    targets = await list_scan_targets(
        repo_rec.repo_full_name, decrypt(repo_rec.github_token_enc), ref=repo_rec.tracked_ref
    )
    repo_rec.token_expires_at = targets.token_expires_at
    head = targets[0]  # list_scan_targets always puts the branch head first
    sha = head["commit_sha"]
    if not await claim_rescan(redis, repo_rec.repo_full_name, sha):
        repo_rec.last_checked_at = datetime.now(UTC)
        await db.commit()
        return {"queued": False, "commit_sha": sha, "reason": "already queued moments ago"}

    submission = await queue_submission(db, redis, arq_pool, repo_rec, **head)
    repo_rec.last_checked_at = datetime.now(UTC)
    await db.commit()
    logger.info("Forced rescan of %s@%s (submission %s)", repo_rec.repo_full_name, sha, submission.id)
    return {"queued": True, "submission_id": str(submission.id), "commit_sha": sha, "branch": head["branch"]}
