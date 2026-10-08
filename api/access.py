"""Repo-visibility access control shared by all routers.

Admins see everything. Analysts see repos they added plus repos in any group
they belong to. Submissions and findings inherit visibility from their repo.

Inaccessible objects return 404 (not 403) so IDs can't be probed for existence.
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import Finding, GroupMember, Repo, RepoGroup, Submission, User


async def visible_repo_names(db: AsyncSession, user: User) -> set[str] | None:
    """Return None (no restriction) for admins, or the set of visible repo names."""
    if user.role == "admin":
        return None
    result = await db.execute(select(Repo.repo_full_name).where(Repo.added_by == user.username))
    names = set(result.scalars().all())
    result = await db.execute(
        select(Repo.repo_full_name)
        .join(RepoGroup, RepoGroup.repo_id == Repo.id)
        .join(GroupMember, GroupMember.group_id == RepoGroup.group_id)
        .where(GroupMember.username == user.username)
    )
    names.update(result.scalars().all())
    return names


async def can_access_repo(db: AsyncSession, user: User, repo_full_name: str) -> bool:
    visible = await visible_repo_names(db, user)
    return visible is None or repo_full_name in visible


async def is_group_member(db: AsyncSession, user: User, group_id: UUID) -> bool:
    if user.role == "admin":
        return True
    return await db.get(GroupMember, (group_id, user.username)) is not None


async def get_accessible_submission(
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Submission:
    """FastAPI dependency: load a submission the current user may access, else 404."""
    sub = await db.get(Submission, submission_id)
    if not sub or not await can_access_repo(db, current_user, sub.repo_full_name):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    return sub


async def get_accessible_finding(
    finding_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Finding:
    """FastAPI dependency: load a finding the current user may access, else 404."""
    finding = await db.get(Finding, finding_id)
    if finding:
        sub = await db.get(Submission, finding.submission_id)
        if sub and await can_access_repo(db, current_user, sub.repo_full_name):
            return finding
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
