"""Test configuration.

Unit tests need nothing external. Integration tests (API + authz) need a
Postgres database and Redis; they use TEST_DATABASE_URL (default: a separate
`custos_test` database) and Redis DB 15, and are skipped if unreachable.
They never touch the dev database.
"""
import os

# Must be set before any app module imports `config`.
os.environ["SECRET_KEY"] = "test-secret-key-" + "x" * 32
os.environ["ENCRYPTION_KEY"] = "test-encryption-key-" + "y" * 32
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://Custos:Custos@localhost:5432/custos_test",
)
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/15")

import httpx  # noqa: E402
import pytest  # noqa: E402


class _FakeJob:
    job_id = "test-job"


class FakeArqPool:
    def __init__(self):
        self.enqueued: list[tuple] = []

    async def enqueue_job(self, name, *args):
        self.enqueued.append((name, *args))
        return _FakeJob()


@pytest.fixture
async def db_engine():
    from database import Base, engine
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
    except (OSError, ConnectionError) as exc:
        pytest.skip(f"test database unavailable: {exc}")
    except Exception as exc:  # e.g. database does not exist
        if "does not exist" in str(exc):
            pytest.skip(f"test database unavailable: {exc}")
        raise
    yield engine
    await engine.dispose()


@pytest.fixture
async def redis():
    from redis.asyncio import Redis
    from config import settings
    r = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await r.flushdb()
    except Exception as exc:
        pytest.skip(f"test redis unavailable: {exc}")
    yield r
    await r.flushdb()
    await r.aclose()


@pytest.fixture
async def client(db_engine, redis):
    from main import app
    app.state.redis = redis
    app.state.arq_pool = FakeArqPool()
    # ASGITransport skips lifespan, so no real ARQ pool is created.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.fixture
async def db(db_engine):
    from database import async_session_factory
    async with async_session_factory() as session:
        yield session
