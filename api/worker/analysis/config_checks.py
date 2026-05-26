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

    if not settings.GITHUB_WEBHOOK_SECRET:
        findings.append(RawFinding(
            source="config",
            severity="high",
            title="GitHub webhook secret not configured",
            description=(
                "GITHUB_WEBHOOK_SECRET is empty. Without it, the /webhook/github endpoint "
                "cannot validate HMAC-SHA256 signatures and will reject all GitHub webhook "
                "deliveries, preventing automated scan triggers."
            ),
            remediation=(
                "Set GITHUB_WEBHOOK_SECRET in api/.env to a strong random value "
                "that matches the secret configured in your GitHub webhook settings."
            ),
        ))

    if not settings.GITHUB_TOKEN:
        findings.append(RawFinding(
            source="config",
            severity="medium",
            title="GitHub token not configured",
            description=(
                "GITHUB_TOKEN is not set. Custos cannot post check-run results back to "
                "GitHub pull requests without a token, so developers will not see scan "
                "results inline in PRs."
            ),
            remediation=(
                "Create a GitHub PAT with Contents:Read and Checks:Write scopes "
                "and set it as GITHUB_TOKEN in api/.env."
            ),
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
