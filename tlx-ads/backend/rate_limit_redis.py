import os
import time
import importlib

from fastapi import HTTPException

from rate_limit import SimpleRateLimiter


class RedisRateLimiter:
    def __init__(self, redis_url: str, limit_per_min: int, prefix: str = "rl"):
        self.redis_url = redis_url
        self.limit = limit_per_min
        self.prefix = prefix
        self._redis = None

    def _get_client(self):
        if self._redis is None:
            mod = importlib.import_module("redis")
            Redis = getattr(mod, "Redis")
            self._redis = Redis.from_url(self.redis_url)
        return self._redis

    def hit(self, key: str) -> None:
        bucket = int(time.time() // 60)
        k = f"{self.prefix}:{key}:{bucket}"

        r = self._get_client()
        val = int(r.incr(k, 1))
        if val == 1:
            # folga de 2 minutos
            r.expire(k, 120)
        if val > self.limit:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")


def get_rate_limiter(limit_per_min: int, prefix: str = "rl"):
    """Retorna rate limiter Redis se REDIS_URL estiver setado, senão fallback in-memory."""

    redis_url = os.getenv("REDIS_URL", "").strip()
    if redis_url:
        return RedisRateLimiter(redis_url=redis_url, limit_per_min=limit_per_min, prefix=prefix)
    return SimpleRateLimiter(limit_per_min=limit_per_min)
