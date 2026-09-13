"""Small TTL cache used for quotes and bar history.

In-process by design: the trading loop is a single process and the cache only
protects the broker's rate limit. Redis (optional) is used elsewhere for
cross-process state sharing, not as the source of truth for prices.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

T = TypeVar("T")


@dataclass
class _Entry(Generic[T]):
    value: T
    expires_at: float


@dataclass
class TTLCache(Generic[T]):
    ttl_seconds: float
    _store: dict[str, _Entry[T]] = field(default_factory=dict)
    hits: int = 0
    misses: int = 0

    def get(self, key: str) -> T | None:
        entry = self._store.get(key)
        if entry is None or entry.expires_at <= time.monotonic():
            self._store.pop(key, None)
            self.misses += 1
            return None
        self.hits += 1
        return entry.value

    def set(self, key: str, value: T, ttl: float | None = None) -> None:
        ttl_value = self.ttl_seconds if ttl is None else ttl
        if ttl_value <= 0:
            return
        self._store[key] = _Entry(value=value, expires_at=time.monotonic() + ttl_value)

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)

    def clear(self) -> None:
        self._store.clear()

    def stats(self) -> dict[str, Any]:
        return {"size": len(self._store), "hits": self.hits, "misses": self.misses}
