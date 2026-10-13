"""Per-user activity: sign-ins, repository changes and admin actions.

Finding decisions and sign-offs already live in audit_log; the Users page
merges both into one history per person.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from models import User, UserActivity

# How stale users.last_seen_at may get before a request refreshes it.
SEEN_EVERY = timedelta(seconds=60)


def record(db: AsyncSession, username: str, action: str, detail: str | None = None) -> None:
    """Add an activity row; the caller's commit saves it with the change itself."""
    db.add(UserActivity(username=username, action=action, detail=(detail or None) and detail[:500]))


async def touch(db: AsyncSession, user: User) -> None:
    """Refresh last_seen_at, at most once per SEEN_EVERY so requests stay read-only."""
    now = datetime.now(UTC)
    if user.last_seen_at is None or now - user.last_seen_at > SEEN_EVERY:
        user.last_seen_at = now
        await db.commit()
