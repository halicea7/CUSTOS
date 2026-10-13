"""Shared fixtures. Requires a PostgreSQL database (TEST_DATABASE_URL).

    docker run -d -p 5432:5432 -e POSTGRES_USER=custos -e POSTGRES_PASSWORD=custos \
        -e POSTGRES_DB=custos_test postgres:16-alpine
"""

import os
import sys
from pathlib import Path

# Settings are read at import time, so configure the environment first.
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://custos:custos@localhost:5432/custos_test"
)
os.environ["SECRET_KEY"] = "test-secret-key-" + "x" * 32
os.environ["ENCRYPTION_KEY"] = "7cQJ3nL0y6bS6mYJ0t8m3q1gk9p0yR2cW5cQeK3qX3o="
os.environ.setdefault("REDIS_URL", "redis://localhost:6379")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fakeredis.aioredis  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402
from main import app  # noqa: E402

from auth import create_access_token, hash_password  # noqa: E402
from crypto import encrypt  # noqa: E402
from database import Base, async_session_factory, engine  # noqa: E402
from models import Finding, Repo, Submission, User  # noqa: E402


class FakeJob:
    def __init__(self, job_id: str):
        self.job_id = job_id


class FakeArqPool:
    def __init__(self):
        self.jobs: list[tuple[str, tuple]] = []

    async def enqueue_job(self, name: str, *args):
        self.jobs.append((name, args))
        return FakeJob(f"job-{len(self.jobs)}")


@pytest.fixture(scope="session", autouse=True)
async def _schema():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


@pytest.fixture(autouse=True)
def _no_github_expiry_lookup(monkeypatch):
    """Adding a repo asks GitHub when its token expires; tests stay offline."""
    import github_client

    async def unknown(repo, token):
        return None

    monkeypatch.setattr(github_client, "fetch_token_expiry", unknown)


@pytest.fixture(autouse=True)
def _no_chain_llm_calls(monkeypatch):
    """The attack-chain pass calls the LLM after every scan; tests stay offline (no chains)."""
    from worker import tasks
    from worker.analysis.llm import LlmResult

    async def no_chains(client, provider, user_prompt, spec):
        return LlmResult(value=[])

    monkeypatch.setattr(tasks, "complete", no_chains)


@pytest.fixture(autouse=True)
async def _clean_tables(_schema):
    yield
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())


@pytest.fixture
async def db():
    async with async_session_factory() as session:
        yield session


@pytest.fixture
async def client():
    app.state.redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    app.state.arq_pool = FakeArqPool()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── factories ────────────────────────────────────────────────────────────────

_PW_HASH = hash_password("password123")


async def make_user(db, username: str, role: str = "analyst") -> User:
    user = User(username=username, hashed_password=_PW_HASH, role=role)
    db.add(user)
    await db.commit()
    return user


def auth_headers(username: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token({'sub': username})}"}


async def make_repo(db, name: str, owner: str, secret: str = "whsecret", token: str = "ghp_" + "a" * 36) -> Repo:
    repo = Repo(
        repo_full_name=name,
        github_token_enc=encrypt(token),
        webhook_secret_enc=encrypt(secret),
        token_last4=token[-4:],
        added_by=owner,
    )
    db.add(repo)
    await db.commit()
    return repo


async def make_submission(db, repo_full_name: str, status: str = "needs_review", findings: list[dict] | None = None) -> Submission:
    sub = Submission(
        repo_full_name=repo_full_name,
        repo_url=f"https://github.com/{repo_full_name}.git",
        commit_sha="a" * 40,
        status=status,
    )
    db.add(sub)
    await db.flush()
    for f in findings or []:
        db.add(Finding(submission_id=sub.id, source="semgrep", title="t", **f))
    await db.commit()
    return sub
