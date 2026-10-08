#!/usr/bin/env python3
"""Re-encrypt all stored repo credentials under the current encryption key.

Run from the api/ directory after changing ENCRYPTION_KEY or SECRET_KEY:

    1. Set the new key in api/.env and put the old one in
       PREVIOUS_ENCRYPTION_KEYS (e.g. PREVIOUS_ENCRYPTION_KEYS=changeme).
    2. ../.venv/bin/python3 rotate_keys.py
    3. Remove PREVIOUS_ENCRYPTION_KEYS from api/.env.
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
        print(f"Re-encrypted credentials for {len(repos)} repo(s).")


if __name__ == "__main__":
    asyncio.run(main())
