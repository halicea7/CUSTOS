#!/usr/bin/env python3
"""Re-encrypt all stored repo secrets under the primary ENCRYPTION_KEY.

Run from the api/ directory after setting or rotating ENCRYPTION_KEY:
    ../.venv/bin/python3 rotate_encryption.py
"""
import asyncio

from sqlalchemy import select

from crypto import rotate
from database import async_session_factory
from models import Repo


async def main() -> None:
    async with async_session_factory() as db:
        repos = (await db.execute(select(Repo))).scalars().all()
        for repo in repos:
            repo.github_token_enc = rotate(repo.github_token_enc)
            repo.webhook_secret_enc = rotate(repo.webhook_secret_enc)
        await db.commit()
        print(f"Re-encrypted secrets for {len(repos)} repo(s)")


if __name__ == "__main__":
    asyncio.run(main())
