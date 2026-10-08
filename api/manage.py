#!/usr/bin/env python3
"""Custos admin commands. Normally invoked by the ./custos launcher.

Run from the api/ directory (or inside the api container):

    python manage.py count-users
    python manage.py create-user <username> [--role admin|analyst]   # password on stdin
    python manage.py reset-password <username>                       # password on stdin
    python manage.py rotate-keys

Passwords are read from stdin (not argv) so they never show up in `ps` or
shell history. Interactive terminals get a hidden prompt.
"""
import argparse
import asyncio
import getpass
import sys

from sqlalchemy import func, select

from auth import hash_password
from database import async_session_factory, engine
from models import Repo, User

_ROLES = ("admin", "analyst")


def _read_password() -> str:
    if sys.stdin.isatty():
        pw = getpass.getpass("Password: ")
        if getpass.getpass("Confirm password: ") != pw:
            sys.exit("Passwords do not match.")
    else:
        pw = sys.stdin.readline().rstrip("\n")
    if len(pw) < 8:
        sys.exit("Password must be at least 8 characters.")
    return pw


async def count_users() -> None:
    async with async_session_factory() as db:
        print((await db.execute(select(func.count()).select_from(User))).scalar_one())


async def create_user(username: str, role: str) -> None:
    password = _read_password()
    async with async_session_factory() as db:
        if (await db.execute(select(User).where(User.username == username))).scalar_one_or_none():
            sys.exit(f"User '{username}' already exists.")
        db.add(User(username=username, hashed_password=hash_password(password), role=role))
        await db.commit()
    print(f"Created user '{username}' with role '{role}'")


async def reset_password(username: str) -> None:
    password = _read_password()
    async with async_session_factory() as db:
        user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            sys.exit(f"User '{username}' not found.")
        user.hashed_password = hash_password(password)
        await db.commit()
    print(f"Password reset for '{username}' (role: {user.role})")


async def rotate_keys() -> None:
    """Re-encrypt stored repo credentials under the current ENCRYPTION_KEY.

    Old keys must be supplied via PREVIOUS_ENCRYPTION_KEYS. Rows that no
    configured key can decrypt are left untouched and reported.
    """
    from cryptography.fernet import InvalidToken
    from crypto import rotate

    rotated, unreadable = 0, []
    async with async_session_factory() as db:
        for repo in (await db.execute(select(Repo))).scalars().all():
            try:
                repo.github_token_enc = rotate(repo.github_token_enc)
                repo.webhook_secret_enc = rotate(repo.webhook_secret_enc)
                rotated += 1
            except InvalidToken:
                unreadable.append(repo.repo_full_name)
        await db.commit()
    print(f"Re-encrypted credentials for {rotated} repo(s).")
    if unreadable:
        print(
            "Could not decrypt (re-enter token/secret on the Repos page): "
            + ", ".join(unreadable)
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("count-users")
    p = sub.add_parser("create-user")
    p.add_argument("username")
    p.add_argument("--role", choices=_ROLES, default="analyst")
    p = sub.add_parser("reset-password")
    p.add_argument("username")
    sub.add_parser("rotate-keys")
    args = parser.parse_args()

    async def run():
        try:
            if args.cmd == "count-users":
                await count_users()
            elif args.cmd == "create-user":
                await create_user(args.username, args.role)
            elif args.cmd == "reset-password":
                await reset_password(args.username)
            elif args.cmd == "rotate-keys":
                await rotate_keys()
        finally:
            await engine.dispose()

    asyncio.run(run())


if __name__ == "__main__":
    main()
