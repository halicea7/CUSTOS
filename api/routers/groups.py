from uuid import UUID

import activity
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from access import can_see_group
from auth import get_current_user, require_admin
from database import get_db
from enums import Role
from models import Group, GroupMember, User
from schemas import (
    GroupCreate,
    GroupMemberAdd,
    GroupMemberResponse,
    GroupResponse,
    GroupUpdate,
)

router = APIRouter(prefix="/groups", tags=["groups"])


async def _member_counts(db: AsyncSession, group_ids: list[UUID]) -> dict[UUID, int]:
    if not group_ids:
        return {}
    rows = await db.execute(
        select(GroupMember.group_id, func.count())
        .where(GroupMember.group_id.in_(group_ids))
        .group_by(GroupMember.group_id)
    )
    return dict(rows.all())


def _response(group: Group, member_count: int) -> GroupResponse:
    return GroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        created_by=group.created_by,
        created_at=group.created_at,
        member_count=member_count,
    )


async def _group_response(db: AsyncSession, group: Group) -> GroupResponse:
    counts = await _member_counts(db, [group.id])
    return _response(group, counts.get(group.id, 0))


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role == Role.ADMIN:
        result = await db.execute(select(Group).order_by(Group.name))
    else:
        result = await db.execute(
            select(Group)
            .join(GroupMember, GroupMember.group_id == Group.id)
            .where(GroupMember.username == current_user.username)
            .order_by(Group.name)
        )
    groups = result.scalars().all()
    counts = await _member_counts(db, [g.id for g in groups])
    return [_response(g, counts.get(g.id, 0)) for g in groups]


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    existing = await db.execute(select(Group).where(Group.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group name already exists")
    group = Group(name=body.name, description=body.description, created_by=current_user.username)
    db.add(group)
    activity.record(db, current_user.username, "group_created", body.name)
    await db.commit()
    await db.refresh(group)
    return await _group_response(db, group)


@router.patch("/{group_id}", response_model=GroupResponse)
async def update_group(
    group_id: UUID,
    body: GroupUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    group = await db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    if body.name is not None:
        existing = await db.execute(select(Group).where(Group.name == body.name, Group.id != group_id))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group name already exists")
        if body.name != group.name:
            activity.record(db, admin.username, "group_renamed", f"{group.name} → {body.name}")
        group.name = body.name
    if body.description is not None:
        group.description = body.description
    await db.commit()
    await db.refresh(group)
    return await _group_response(db, group)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: UUID,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    group = await db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    activity.record(db, admin.username, "group_deleted", group.name)
    await db.delete(group)
    await db.commit()


@router.get("/{group_id}/members", response_model=list[GroupMemberResponse])
async def list_members(
    group_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    group = await db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    if not await can_see_group(db, current_user, group_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a member of this group")
    result = await db.execute(
        select(GroupMember).where(GroupMember.group_id == group_id).order_by(GroupMember.joined_at)
    )
    return [
        GroupMemberResponse(username=m.username, added_by=m.added_by, joined_at=m.joined_at)
        for m in result.scalars().all()
    ]


@router.post("/{group_id}/members", status_code=status.HTTP_204_NO_CONTENT)
async def add_member(
    group_id: UUID,
    body: GroupMemberAdd,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    group = await db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    user_exists = await db.execute(select(User).where(User.username == body.username))
    if not user_exists.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    existing = await db.get(GroupMember, (group_id, body.username))
    if not existing:
        db.add(GroupMember(group_id=group_id, username=body.username, added_by=current_user.username))
        activity.record(db, current_user.username, "member_added", f"{body.username} → {group.name}")
        await db.commit()


@router.delete("/{group_id}/members/{username}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    group_id: UUID,
    username: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    group = await db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    mem = await db.get(GroupMember, (group_id, username))
    if not mem:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    activity.record(db, admin.username, "member_removed", f"{username} ← {group.name}")
    await db.delete(mem)
    await db.commit()
