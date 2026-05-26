from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user, require_admin
from crypto import decrypt, encrypt
from database import get_db
from models import Group, GroupMember, Repo, RepoGroup, User
from schemas import (
    GroupSummary,
    RepoCreate,
    RepoResponse,
    RepoUpdate,
    ValidateTokenRequest,
)

router = APIRouter(prefix="/repos", tags=["repos"])


def _mask(value: str) -> str:
    return f"••••••••{value[-4:]}" if len(value) >= 4 else "••••••••"


async def _repo_groups(db: AsyncSession, repo_id: UUID) -> list[GroupSummary]:
    result = await db.execute(
        select(Group)
        .join(RepoGroup, RepoGroup.group_id == Group.id)
        .where(RepoGroup.repo_id == repo_id)
        .order_by(Group.name)
    )
    return [GroupSummary(id=g.id, name=g.name) for g in result.scalars().all()]


async def _to_response(db: AsyncSession, repo: Repo) -> RepoResponse:
    groups = await _repo_groups(db, repo.id)
    try:
        raw_token = decrypt(repo.github_token_enc)
        preview = _mask(raw_token)
    except Exception:
        preview = "••••••••????"
    return RepoResponse(
        id=repo.id,
        repo_full_name=repo.repo_full_name,
        added_by=repo.added_by,
        added_at=repo.added_at,
        last_push_at=repo.last_push_at,
        enabled=repo.enabled,
        token_preview=preview,
        groups=groups,
    )


async def _visible_repo_names(db: AsyncSession, user: User) -> set[str] | None:
    """Return None (no restriction) for admins, or a set of visible repo names."""
    if user.role == "admin":
        return None
    # Own repos
    result = await db.execute(select(Repo.repo_full_name).where(Repo.added_by == user.username))
    names = set(result.scalars().all())
    # Group repos — repos in any group the user belongs to
    gm_result = await db.execute(
        select(RepoGroup.repo_id)
        .join(GroupMember, GroupMember.group_id == RepoGroup.group_id)
        .where(GroupMember.username == user.username)
    )
    group_repo_ids = [r for r in gm_result.scalars().all()]
    if group_repo_ids:
        r2 = await db.execute(select(Repo.repo_full_name).where(Repo.id.in_(group_repo_ids)))
        names.update(r2.scalars().all())
    return names


@router.get("", response_model=list[RepoResponse])
async def list_repos(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    visible = await _visible_repo_names(db, current_user)
    q = select(Repo).order_by(Repo.added_at.desc())
    if visible is not None:
        q = q.where(Repo.repo_full_name.in_(visible))
    result = await db.execute(q)
    repos = result.scalars().all()
    return [await _to_response(db, r) for r in repos]


@router.post("", response_model=RepoResponse, status_code=status.HTTP_201_CREATED)
async def add_repo(
    body: RepoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = body.repo_full_name.strip().strip("/")
    existing = await db.execute(select(Repo).where(Repo.repo_full_name == name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Repository already registered")

    repo = Repo(
        repo_full_name=name,
        github_token_enc=encrypt(body.github_token),
        webhook_secret_enc=encrypt(body.webhook_secret),
        added_by=current_user.username,
        enabled=True,
    )
    db.add(repo)
    await db.flush()

    for gid in body.group_ids:
        grp = await db.get(Group, gid)
        if not grp:
            continue
        if current_user.role != "admin":
            mem = await db.get(GroupMember, (gid, current_user.username))
            if not mem:
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
    repo = await db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    if current_user.role != "admin" and repo.added_by != current_user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your repository")

    if body.github_token is not None:
        repo.github_token_enc = encrypt(body.github_token)
    if body.webhook_secret is not None:
        repo.webhook_secret_enc = encrypt(body.webhook_secret)
    if body.enabled is not None:
        repo.enabled = body.enabled

    await db.commit()
    await db.refresh(repo)
    return await _to_response(db, repo)


@router.delete("/{repo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_repo(
    repo_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = await db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    if current_user.role != "admin" and repo.added_by != current_user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your repository")
    await db.delete(repo)
    await db.commit()


@router.post("/{repo_id}/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def add_repo_to_group(
    repo_id: UUID,
    group_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    repo = await db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    if current_user.role != "admin" and repo.added_by != current_user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your repository")
    grp = await db.get(Group, group_id)
    if not grp:
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
    repo = await db.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Repository not found")
    if current_user.role != "admin" and repo.added_by != current_user.username:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your repository")
    await db.execute(
        sql_delete(RepoGroup).where(RepoGroup.repo_id == repo_id, RepoGroup.group_id == group_id)
    )
    await db.commit()


@router.post("/validate-token")
async def validate_token(
    body: ValidateTokenRequest,
    _: User = Depends(get_current_user),
):
    name = body.repo_full_name.strip().strip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{name}",
                headers={
                    "Authorization": f"token {body.github_token}",
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
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "repo_name": data.get("full_name"),
        "default_branch": data.get("default_branch"),
        "private": data.get("private"),
    }
