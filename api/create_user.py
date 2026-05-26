#!/usr/bin/env python3
"""Create an analyst/admin user. Run from the api/ directory after migrations.

Usage:
    python create_user.py <username> <password> [role]

Example:
    python create_user.py admin secret123 admin
"""
import asyncio
import sys

from auth import hash_password
from database import async_session_factory
from models import User


async def create_user(username: str, password: str, role: str = "analyst") -> None:
    async with async_session_factory() as db:
        user = User(
            username=username,
            hashed_password=hash_password(password),
            role=role,
        )
        db.add(user)
        await db.commit()
        print(f"Created user '{username}' with role '{role}'")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    _role = sys.argv[3] if len(sys.argv) > 3 else "analyst"
    asyncio.run(create_user(sys.argv[1], sys.argv[2], _role))
