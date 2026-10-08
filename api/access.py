"""Row-level access control shared by every router.

Admins see everything. Analysts see repos they added plus repos attached to any
group they belong to. Anything outside that set is reported as 404 so that the
existence of other teams' submissions is not disclosed.
"""

from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from models import Finding, GroupMember, Repo, RepoGroup, Submission, User


def visible_repos_subquery(user: User) -> Select:
    """SELECT repo_full_name of every repo *user* may see (non-admins only)."""
    group_repo_ids = (
        select(RepoGroup.repo_id)
        .join(GroupMember, GroupMember.group_id == RepoGroup.group_id)
        .where(GroupMember.username == user.username)
    )
    return select(Repo.repo_full_name).where(
        or_(Repo.added_by == user.username, Repo.id.in_(group_repo_ids))
    )


async def visible_repo_names(db: AsyncSession, user: User) -> set[str] | None:
    """Return None (no restriction) for admins, or the set of visible repo names."""
    if user.role == "admin":
        return None
    result = await db.execute(visible_repos_subquery(user))
    return set(result.scalars().all())


def restrict_to_visible(query: Select, user: User, column=Submission.repo_full_name) -> Select:
    """Add a WHERE clause limiting *query* to repos *user* may see."""
    if user.role == "admin":
        return query
    return query.where(column.in_(visible_repos_subquery(user)))


async def can_see_repo(db: AsyncSession, user: User, repo_full_name: str) -> bool:
    if user.role == "admin":
        return True
    q = visible_repos_subquery(user).where(Repo.repo_full_name == repo_full_name).limit(1)
    return (await db.execute(q)).scalar_one_or_none() is not None


async def can_see_group(db: AsyncSession, user: User, group_id: UUID) -> bool:
    if user.role == "admin":
        return True
    return await db.get(GroupMember, (group_id, user.username)) is not None


async def get_visible_submission(
    submission_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Submission:
    sub = await db.get(Submission, submission_id)
    if not sub or not await can_see_repo(db, user, sub.repo_full_name):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    return sub


async def get_visible_finding(
    finding_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Finding:
    finding = await db.get(Finding, finding_id)
    if finding:
        sub = await db.get(Submission, finding.submission_id)
        if sub and await can_see_repo(db, user, sub.repo_full_name):
            return finding
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
