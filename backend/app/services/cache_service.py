"""
In-memory cache with TTL support.
Background refresh is driven by APScheduler (configured in main.py).
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


class CacheEntry:
    def __init__(self, data: Any, ttl_seconds: int):
        self.data = data
        self.cached_at = datetime.now(timezone.utc)
        self.ttl_seconds = ttl_seconds

    @property
    def age_seconds(self) -> int:
        return int((datetime.now(timezone.utc) - self.cached_at).total_seconds())

    @property
    def is_expired(self) -> bool:
        return self.age_seconds >= self.ttl_seconds

    @property
    def cached_at_iso(self) -> str:
        return self.cached_at.isoformat()


class CacheService:
    """
    Thread-safe in-memory TTL cache.
    Keys: string identifiers for each dashboard data segment.
    """

    def __init__(self, default_ttl: int = 300):
        self._store: dict[str, CacheEntry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._default_ttl = default_ttl

    def _get_lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def get(self, key: str) -> Optional[Any]:
        entry = self._store.get(key)
        if entry and not entry.is_expired:
            logger.debug(f"Cache HIT for '{key}' (age={entry.age_seconds}s)")
            return entry.data
        if entry and entry.is_expired:
            logger.debug(f"Cache EXPIRED for '{key}'")
        return None

    def set(self, key: str, data: Any, ttl: Optional[int] = None) -> None:
        ttl = ttl or self._default_ttl
        self._store[key] = CacheEntry(data, ttl)
        logger.debug(f"Cache SET for '{key}' (ttl={ttl}s)")

    def invalidate(self, key: str) -> None:
        self._store.pop(key, None)
        logger.info(f"Cache INVALIDATED for '{key}'")

    def invalidate_all(self) -> None:
        self._store.clear()
        logger.info("Cache INVALIDATED all keys")

    def get_meta(self, key: str) -> Optional[dict]:
        entry = self._store.get(key)
        if not entry:
            return None
        return {
            "cached": True,
            "cached_at": entry.cached_at_iso,
            "age_seconds": entry.age_seconds,
            "ttl_seconds": entry.ttl_seconds,
            "is_expired": entry.is_expired,
        }

    async def get_or_fetch(
        self,
        key: str,
        fetch_fn: Callable,
        ttl: Optional[int] = None,
    ) -> Any:
        """
        Return cached value if fresh, otherwise call fetch_fn() and cache result.
        Uses per-key locking to prevent thundering herd on cache miss.
        """
        cached = self.get(key)
        if cached is not None:
            return cached

        async with self._get_lock(key):
            # Double-check after acquiring lock
            cached = self.get(key)
            if cached is not None:
                return cached

            logger.info(f"Cache MISS for '{key}', fetching...")
            data = await fetch_fn()
            self.set(key, data, ttl)
            return data

    def list_keys(self) -> list[dict]:
        return [
            {
                "key": k,
                "age_seconds": v.age_seconds,
                "expired": v.is_expired,
                "cached_at": v.cached_at_iso,
            }
            for k, v in self._store.items()
        ]


# Singleton
_cache: CacheService | None = None


def get_cache() -> CacheService:
    global _cache
    if _cache is None:
        from app.config import get_settings
        settings = get_settings()
        _cache = CacheService(default_ttl=settings.cache_ttl_seconds)
    return _cache
