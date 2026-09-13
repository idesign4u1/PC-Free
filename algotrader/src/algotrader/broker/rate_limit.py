"""Client-side rate limiting.

Tradier aggregates requests over rolling one-minute windows (roughly 120/min in
production and 60/min in sandbox for market data) and returns
``X-Ratelimit-*`` headers. We throttle locally so that a burst of symbol
requests never trips the broker's limiter mid-session.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field


@dataclass
class RateLimiter:
    """Simple sliding-window limiter, safe for concurrent coroutines."""

    max_calls: int
    period_seconds: float = 60.0
    _calls: list[float] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def acquire(self) -> float:
        """Block until a slot is free. Returns seconds spent waiting."""
        waited = 0.0
        while True:
            async with self._lock:
                now = time.monotonic()
                cutoff = now - self.period_seconds
                self._calls = [t for t in self._calls if t > cutoff]
                if len(self._calls) < self.max_calls:
                    self._calls.append(now)
                    return waited
                sleep_for = max(0.01, self._calls[0] + self.period_seconds - now)
            await asyncio.sleep(sleep_for)
            waited += sleep_for

    def observe_headers(self, headers: dict[str, str]) -> dict[str, int]:
        """Parse the broker's own rate-limit headers for monitoring."""
        out: dict[str, int] = {}
        for key in ("allowed", "used", "available", "expiry"):
            raw = headers.get(f"x-ratelimit-{key}") or headers.get(f"X-Ratelimit-{key}")
            if raw is None:
                continue
            try:
                out[key] = int(raw)
            except (TypeError, ValueError):
                continue
        return out
