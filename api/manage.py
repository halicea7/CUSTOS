#!/usr/bin/env python3
"""Custos admin commands. Normally invoked by the ./custos launcher.

Run from the api/ directory (or inside the api container):

    python manage.py count-users
    python manage.py create-user <username> [--role admin|analyst]   # password on stdin
    python manage.py reset-password <username>                       # password on stdin
    python manage.py rotate-keys
    python manage.py self-update-status <commit-sha>   # used by ./custos update

Passwords are read from stdin (not argv) so they never show up in `ps` or
shell history. Interactive terminals get a hidden prompt.

rotate-keys re-encrypts stored repo secrets under the first ENCRYPTION_KEY.
Anything the configured keys can decrypt is migrated, including rows from
before ENCRYPTION_KEY existed (via the SECRET_KEY-derived fallback in
crypto.py; set SECRET_KEY to the *old* value for the run if it has changed).
"""
import argparse
import asyncio
import getpass
import sys

from sqlalchemy import func, select

from app_config import RESPONSES_API_KEY, S1_TOKEN
from auth import hash_password
from database import async_session_factory, engine
from enums import Role
from models import AppConfig, Repo, User

_ROLES = tuple(r.value for r in Role)


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
    """Re-encrypt stored repo credentials under the primary ENCRYPTION_KEY.

    Rows that no configured key can decrypt are left untouched and reported.
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
        for key, label in ((RESPONSES_API_KEY, "Responses API key (Settings)"),
                           (S1_TOKEN, "SentinelOne token (Settings)")):
            row = await db.get(AppConfig, key)
            if row:
                try:
                    row.value = rotate(row.value)
                except InvalidToken:
                    unreadable.append(label)
        await db.commit()
    print(f"Re-encrypted credentials for {rotated} repo(s).")
    if unreadable:
        print(
            "Could not decrypt (re-enter on the Repos / Settings page): "
            + ", ".join(unreadable)
        )


async def self_update_status(sha: str) -> None:
    """Print, as JSON, whether *sha* of Custos's own repo is approved to deploy.

    Approved = the configured self-update repo has a submission for exactly
    this commit, an admin signed it off, and no critical/high finding was
    dispositioned as a real issue (confirmed/escalated). Exit code 0 if
    approved, 1 otherwise, so ./custos update can rely on either.
    """
    import json

    from sqlalchemy import desc

    from app_config import SELF_UPDATE_REPO
    from enums import BLOCKING_SEVERITIES, Disposition, SubmissionStatus
    from models import AuditLog, Finding, Submission

    out: dict = {"sha": sha, "approved": False}
    async with async_session_factory() as db:
        row = await db.get(AppConfig, SELF_UPDATE_REPO)
        out["repo"] = row.value if row else ""
        if not out["repo"]:
            out["reason"] = "No self-update repo is set (Settings → Analysis → Self-update)."
        else:
            sub = (await db.execute(
                select(Submission)
                .where(Submission.repo_full_name == out["repo"], Submission.commit_sha == sha)
                .order_by(desc(Submission.created_at)).limit(1)
            )).scalar_one_or_none()
            if not sub:
                out["reason"] = "Custos has not scanned this commit (is the webhook set up for the repo?)."
            else:
                out["status"] = sub.status
                findings = (await db.execute(
                    select(Finding.severity, Finding.disposition).where(Finding.submission_id == sub.id)
                )).all()
                out["findings"] = len(findings)
                real_blockers = sum(
                    1 for sev, disp in findings
                    if sev in BLOCKING_SEVERITIES and disp in (Disposition.CONFIRMED, Disposition.ESCALATED)
                )
                signoff = (await db.execute(
                    select(AuditLog, User.role)
                    .join(User, User.username == AuditLog.analyst, isouter=True)
                    .where(AuditLog.submission_id == sub.id, AuditLog.action == "sign_off")
                    .order_by(desc(AuditLog.created_at)).limit(1)
                )).first()
                if signoff:
                    out["signed_off_by"] = signoff[0].analyst
                if sub.status != SubmissionStatus.SIGNED_OFF:
                    out["reason"] = f"Not signed off yet (status: {sub.status})."
                elif not signoff or signoff[1] != Role.ADMIN:
                    out["reason"] = "Signed off, but not by an admin."
                elif real_blockers:
                    out["reason"] = (f"{real_blockers} critical/high finding(s) were confirmed as real "
                                     "issues; fix them in a new commit.")
                else:
                    out["approved"] = True
    print(json.dumps(out))
    sys.exit(0 if out["approved"] else 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("count-users")
    p = sub.add_parser("create-user")
    p.add_argument("username")
    p.add_argument("--role", choices=_ROLES, default=Role.ANALYST.value)
    p = sub.add_parser("reset-password")
    p.add_argument("username")
    sub.add_parser("rotate-keys")
    p = sub.add_parser("self-update-status")
    p.add_argument("sha")
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
            elif args.cmd == "self-update-status":
                await self_update_status(args.sha)
        finally:
            await engine.dispose()

    asyncio.run(run())


if __name__ == "__main__":
    main()
