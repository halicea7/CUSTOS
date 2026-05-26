"""Runtime configuration security checks for Custos self-assessment."""

import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from worker.analysis.sast import RawFinding

logger = logging.getLogger(__name__)


async def run_config_checks(db: AsyncSession) -> list[RawFinding]:
    findings: list[RawFinding] = []

    if settings.SECRET_KEY == "changeme":
        findings.append(RawFinding(
            source="config",
            severity="critical",
            title="Weak default SECRET_KEY in use",
            description=(
                "The application is using the hardcoded default SECRET_KEY 'changeme'. "
                "This key signs all JWT authentication tokens — anyone who knows it can forge "
                "admin-level tokens without credentials."
            ),
            remediation=(
                "Generate a strong key and set it in api/.env:\n"
                "  python -c \"import secrets; print(secrets.token_hex(32))\""
            ),
        ))

    from models import Repo
    repo_result = await db.execute(select(func.count()).select_from(Repo))
    repo_count = repo_result.scalar_one()
    if repo_count == 0:
        findings.append(RawFinding(
            source="config",
            severity="medium",
            title="No repositories registered",
            description=(
                "No GitHub repositories have been connected to Custos. "
                "Webhook deliveries will be rejected and no automated scans can run."
            ),
            remediation="Add a repository via the Repos page in the dashboard.",
        ))

    disabled_result = await db.execute(
        select(func.count()).select_from(Repo).where(Repo.enabled == False)  # noqa: E712
    )
    disabled_count = disabled_result.scalar_one()
    if disabled_count > 0:
        findings.append(RawFinding(
            source="config",
            severity="info",
            title=f"{disabled_count} repository disabled",
            description=(
                f"{disabled_count} registered {'repository is' if disabled_count == 1 else 'repositories are'} "
                "currently disabled and will not trigger scans on push or PR events."
            ),
            remediation="Re-enable the repository from the Repos page if this is unintentional.",
        ))

    redis_url = settings.REDIS_URL
    # URLs like redis://localhost or redis://127.0.0.1 have no auth
    stripped = redis_url.replace("redis://", "").replace("rediss://", "")
    has_auth = "@" in stripped and ":" in stripped.split("@")[0]
    if not has_auth:
        findings.append(RawFinding(
            source="config",
            severity="medium",
            title="Redis running without authentication",
            description=(
                "The Redis URL contains no credentials. In any networked environment "
                "this allows unauthenticated access to the ARQ job queue, potentially "
                "enabling job injection, data leakage, or denial of service."
            ),
            remediation=(
                "Add requirepass to your Redis config and update REDIS_URL to "
                "redis://:yourpassword@host:port in api/.env."
            ),
        ))

    # Check admin user exists
    from models import User
    result = await db.execute(
        select(func.count()).select_from(User).where(User.role == "admin")
    )
    admin_count = result.scalar_one()
    if admin_count == 0:
        findings.append(RawFinding(
            source="config",
            severity="high",
            title="No admin users configured",
            description=(
                "No user accounts with the 'admin' role exist. Without an admin account "
                "the security settings panel is inaccessible and scan configuration "
                "cannot be managed through the dashboard."
            ),
            remediation=(
                "Create an admin user via POST /auth/register or directly in the database: "
                "UPDATE users SET role='admin' WHERE username='youruser';"
            ),
        ))

    logger.info("config checks: %d findings", len(findings))
    return findings
