import logging
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI
from redis.asyncio import Redis

from config import settings
from database import engine
from routers import auth as auth_router
from routers import findings as findings_router
from routers import groups as groups_router
from routers import health as health_router
from routers import repos as repos_router
from routers import settings as settings_router
from routers import signoff as signoff_router
from routers import submissions as submissions_router
from routers import webhook as webhook_router

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


def _arq_settings() -> RedisSettings:
    url = urlparse(settings.REDIS_URL)
    return RedisSettings(host=url.hostname or "localhost", port=url.port or 6379)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.redis = Redis.from_url(settings.REDIS_URL, decode_responses=True)
    app.state.arq_pool = await create_pool(_arq_settings())
    yield
    await app.state.redis.aclose()
    await app.state.arq_pool.aclose()
    await engine.dispose()


app = FastAPI(title="Custos API", version="1.0.0", lifespan=lifespan)

app.include_router(auth_router.router)
app.include_router(webhook_router.router)
app.include_router(submissions_router.router)
app.include_router(findings_router.router)
app.include_router(signoff_router.router)
app.include_router(settings_router.router)
app.include_router(health_router.router)
app.include_router(repos_router.router)
app.include_router(groups_router.router)


@app.get("/healthz", tags=["system"])
async def healthz():
    return {"status": "ok"}
