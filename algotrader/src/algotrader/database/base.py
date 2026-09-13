"""Async SQLAlchemy engine/session management.

PostgreSQL in production (``postgresql+asyncpg://``), SQLite for tests and
single-file local runs (``sqlite+aiosqlite://``). Schema creation is handled by
``create_all`` - the model set is additive, so there is no migration tool in
the loop for the first release.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from ..logging_setup import get_logger

log = get_logger(__name__)


class Base(DeclarativeBase):
    pass


class Database:
    """Owns the engine and hands out sessions."""

    def __init__(self, url: str, echo: bool = False) -> None:
        self.url = url
        kwargs: dict = {"echo": echo, "future": True}
        if url.startswith("postgresql"):
            kwargs.update({"pool_size": 5, "max_overflow": 10, "pool_pre_ping": True})
        self.engine: AsyncEngine = create_async_engine(url, **kwargs)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False, class_=AsyncSession)

    async def create_all(self) -> None:
        from . import models  # noqa: F401  (import registers the mappers)

        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        log.info("database_schema_ready", backend=self.url.split("://", 1)[0])

    async def drop_all(self) -> None:
        from . import models  # noqa: F401

        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def healthy(self) -> bool:
        from sqlalchemy import text

        try:
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
            return True
        except Exception as exc:  # pragma: no cover - depends on external service
            log.warning("database_health_check_failed", error=str(exc))
            return False

    async def close(self) -> None:
        await self.engine.dispose()
