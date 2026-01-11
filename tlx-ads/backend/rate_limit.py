import time
from fastapi import HTTPException


class SimpleRateLimiter:
    def __init__(self, limit_per_min: int):
        self.limit = limit_per_min
        self.buckets: dict[str, int] = {}  # key:window -> count

    def hit(self, key: str) -> None:
        now = time.time()
        window = int(now // 60)
        wk = f"{key}:{window}"
        count = self.buckets.get(wk, 0) + 1
        self.buckets[wk] = count
        if count > self.limit:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
