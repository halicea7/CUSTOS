import re
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_group, restrict_to_visible
from auth import get_current_user
from crypto import decrypt, encrypt
from database import get_db
from enums import Role
from intake import check_repo_for_updates
from models import Group, Repo, RepoGroup, User
from schemas import (
    GroupSummary,
    RepoCreate,
    RepoResponse,
    RepoUpdate,
    ValidateTokenRequest,
)
from worker.analysis.clone import redact

router = APIRouter(prefix="/repos", tags=["repos"])


_REPO_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _normalise_name(raw: str) -> str:
    name = raw.strip().strip("/")
    if not _REPO_NAME.match(name) or any(part in (".", "..") for part in name.split("/")):
        raise HTTPException(
            status_code=422,
            detail="Repository must be in 'owner/name' form",
        )
    return name


def _preview(last4: str | None) -> str:
    return f"••••••••{last4}" if last4 else "••••••••"


async def _groups_for(db: AsyncSession, repo_ids: list[UUID]) -> dict[UUID, list[GroupSummary]]:
    if not repo_ids:
        return {}
    rows = await db.execute(
        select(RepoGroup.repo_id, Group.id, Group.name)
        .join(Group, Group.id == RepoGroup.group_id)
        .where(RepoGroup.repo_id.in_(repo_ids))
        .order_by(Group.name)
    )
    out: dict[UUID, list[GroupSummary]] = {}
    for repo_id, gid, gname in rows:
        out.setdefault(repo_id, []).append(GroupSummary(id=gid, name=gname))
    return out


async def _backfill_last4(db: AsyncSession, repos: list[Repo]) -> None:
    """Populate token_last4 for rows created before the column existed."""
    changed = False
    for repo in repos:
        if repo.token_last4 is None:
            try:
                repo.token_last4 = decrypt(repo.github_token_enc)[-4:]
                changed = True
            except Exception:
                pass
    if changed:
        await db.commit()


def _response(repo: Repo, groups: list[GroupSummary]) -> RepoResponse:
    return RepoResponse(
        id=repo.id,
        repo_full_name=repo.repo_full_name,
        added_by=repo.added_by,
        added_at=repo.added_at,
        last_push_at=repo.last_push_at,
        last_checked_at=repo.last_checked_at,
        enabled=repo.enabled,
        token_preview=_preview(repo.token_last4),
        groups=groups,
    )


async def _to_response(db: AsyncSession, repo: Repo) -> RepoResponse:
    groups = await _groups_for(db, [repo.id])
    return _response(repo, groups.get(repo.id, []))


def _require_owner(repo: Repo | None, user: User) -> Repo:
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    if user.role != Role.ADMIN and repo.added_by != user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your repository")
    return repo


@router.get("", response_model=list[RepoResponse])
async def list_repos(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = restrict_to_visible(select(Repo).order_by(Repo.added_at.desc()), current_user, Repo.repo_full_name)
    repos = list((await db.execute(q)).scalars().all())
    await _backfill_last4(db, repos)
    groups = await _groups_for(db, [r.id for r in repos])
    return [_response(r, groups.get(r.id, [])) for r in repos]


@router.post("", response_model=RepoResponse, status_code=status.HTTP_201_CREATED)
async def add_repo(
    body: RepoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = _normalise_name(body.repo_full_name)
    existing = await db.execute(select(Repo).where(Repo.repo_full_name == name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Repository already registered")

    repo = Repo(
        repo_full_name=name,
        github_token_enc=encrypt(body.github_token),
        webhook_secret_enc=encrypt(body.webhook_secret),
        token_last4=body.github_token[-4:],
        added_by=current_user.username,
        enabled=True,
    )
    db.add(repo)
    await db.flush()

    for gid in body.group_ids:
        grp = await db.get(Group, gid)
        if not grp:
            continue
        if not await can_see_group(db, current_user, gid):
            continue
        db.add(RepoGroup(repo_id=repo.id, group_id=gid))

    await db.commit()
    await db.refresh(repo)
    return await _to_response(db, repo)


@router.patch("/{repo_id}", response_model=RepoResponse)
async def update_repo(
    repo_id: UUID,
    body: RepoUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = _require_owner(await db.get(Repo, repo_id), current_user)

    if body.github_token is not None:
        repo.github_token_enc = encrypt(body.github_token)
        repo.token_last4 = body.github_token[-4:]
    if body.webhook_secret is not None:
        repo.webhook_secret_enc = encrypt(body.webhook_secret)
    if body.enabled is not None:
        repo.enabled = body.enabled

    await db.commit()
    await db.refresh(repo)
    return await _to_response(db, repo)


@router.post("/{repo_id}/check-updates")
async def check_updates(
    repo_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Look for unscanned commits (default branch head, open PRs) and queue them.

    The webhook-free way to keep a repo scanned: outbound calls to GitHub only.
    """
    repo = _require_owner(await db.get(Repo, repo_id), current_user)
    if not repo.enabled:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Repository is disabled")
    try:
        return await check_repo_for_updates(
            db, request.app.state.redis, request.app.state.arq_pool, repo
        )
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        hint = {401: "the token was rejected", 403: "the token lacks access or hit a rate limit",
                404: "repository not found, or the token can't see it"}.get(code, "unexpected response")
        raise HTTPException(status_code=502, detail=f"GitHub returned {code}: {hint}") from None
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach GitHub ({type(exc).__name__})") from None


@router.delete("/{repo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_repo(
    repo_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = _require_owner(await db.get(Repo, repo_id), current_user)
    await db.delete(repo)
    await db.commit()


@router.post("/{repo_id}/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def add_repo_to_group(
    repo_id: UUID,
    group_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_owner(await db.get(Repo, repo_id), current_user)
    grp = await db.get(Group, group_id)
    if not grp or not await can_see_group(db, current_user, group_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    existing = await db.get(RepoGroup, (repo_id, group_id))
    if not existing:
        db.add(RepoGroup(repo_id=repo_id, group_id=group_id))
        await db.commit()


@router.delete("/{repo_id}/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_repo_from_group(
    repo_id: UUID,
    group_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_owner(await db.get(Repo, repo_id), current_user)
    await db.execute(
        sql_delete(RepoGroup).where(RepoGroup.repo_id == repo_id, RepoGroup.group_id == group_id)
    )
    await db.commit()


@router.post("/validate-token")
async def validate_token(
    body: ValidateTokenRequest,
    _: User = Depends(get_current_user),
):
    name = _normalise_name(body.repo_full_name)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{name}",
                headers={
                    "Authorization": f"Bearer {body.github_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            if resp.status_code == 401:
                return {"ok": False, "error": "Token is invalid or expired"}
            if resp.status_code == 404:
                return {"ok": False, "error": "Repository not found or token lacks access"}
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        return {"ok": False, "error": "GitHub API timed out"}
    except Exception as exc:
        return {"ok": False, "error": redact(str(exc), body.github_token)}
    return {
        "ok": True,
        "repo_name": data.get("full_name"),
        "default_branch": data.get("default_branch"),
        "private": data.get("private"),
    }
