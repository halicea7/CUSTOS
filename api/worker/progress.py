"""Real per-stage progress for long jobs, published to Redis for the UI.

Each stage is pending → running → done | failed (or skipped). The dashboard
renders exactly these states instead of guessing from elapsed time.
"""

import json
import logging
from collections.abc import Awaitable
from typing import Any, TypeVar

from redis_util import scan_stages_key

logger = logging.getLogger(__name__)

T = TypeVar("T")
_TTL_SECONDS = 3 * 3600


class StageTracker:
    def __init__(self, redis, scan_id, stages: list[tuple[str, str, str]]):
        """*stages*: (id, label, tool) in display order."""
        self._redis = redis
        self._key = scan_stages_key(scan_id)
        self.stages: dict[str, dict[str, Any]] = {
            sid: {"id": sid, "label": label, "tool": tool, "state": "pending", "detail": None}
            for sid, label, tool in stages
        }

    async def set(self, stage: str, state: str, detail: str | None = None) -> None:
        if stage not in self.stages:
            return
        self.stages[stage].update(state=state, detail=detail)
        await self.publish()

    async def run(self, stage: str, aw: Awaitable[T]) -> T:
        """Await *aw*, marking *stage* running, then done (or failed on error)."""
        await self.set(stage, "running")
        try:
            result = await aw
        except BaseException:
            await self.set(stage, "failed")
            raise
        await self.set(stage, "done")
        return result

    async def publish(self) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.set(self._key, json.dumps(list(self.stages.values())), ex=_TTL_SECONDS)
        except Exception as exc:  # progress is best-effort; never fail the job over it
            logger.debug("Could not publish stage progress: %s", exc)
