#!/usr/bin/env python3
"""Reset a user's password. Run from the api/ directory.

Usage:
    python reset_password.py <username> <new_password>

Example:
    python reset_password.py admin newsecret123
"""
import asyncio
import sys

from sqlalchemy import select

from auth import hash_password
from database import async_session_factory
from models import User


async def reset_password(username: str, password: str) -> None:
    async with async_session_factory() as db:
        result = await db.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()
        if not user:
            print(f"Error: user '{username}' not found.")
            sys.exit(1)
        user.hashed_password = hash_password(password)
        await db.commit()
        print(f"Password reset for '{username}' (role: {user.role})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    asyncio.run(reset_password(sys.argv[1], sys.argv[2]))
