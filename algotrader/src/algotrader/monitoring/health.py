"""System health checks.

The health report is what the kill switch and the dashboard both read. It is
deliberately blunt: any failing component means "do not open new risk".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..broker.base import BrokerAdapter
from ..database.base import Database
from ..logging_setup import get_logger
from ..utils.timeutils import utc_now

log = get_logger(__name__)


@dataclass
class ComponentHealth:
    name: str
    healthy: bool
    detail: str = ""
    checked_at: datetime = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "healthy": self.healthy,
            "detail": self.detail,
            "checked_at": self.checked_at.isoformat(),
        }


@dataclass
class HealthReport:
    components: list[ComponentHealth] = field(default_factory=list)
    checked_at: datetime = field(default_factory=utc_now)

    @property
    def healthy(self) -> bool:
        return all(component.healthy for component in self.components)

    @property
    def failures(self) -> list[ComponentHealth]:
        return [component for component in self.components if not component.healthy]

    def to_dict(self) -> dict[str, Any]:
        return {
            "healthy": self.healthy,
            "checked_at": self.checked_at.isoformat(),
            "components": [component.to_dict() for component in self.components],
        }


class HealthMonitor:
    def __init__(
        self,
        broker: BrokerAdapter,
        database: Database | None = None,
        heartbeat_timeout_seconds: int = 300,
    ) -> None:
        self.broker = broker
        self.database = database
        self.heartbeat_timeout_seconds = heartbeat_timeout_seconds
        self.last_loop_at: datetime | None = None
        self.last_report: HealthReport | None = None

    def heartbeat(self, moment: datetime | None = None) -> None:
        self.last_loop_at = moment or utc_now()

    async def check(self) -> HealthReport:
        now = utc_now()
        components: list[ComponentHealth] = []

        try:
            broker_ok = await self.broker.health_check()
            detail = "" if broker_ok else "broker health check failed"
        except Exception as exc:
            broker_ok, detail = False, f"broker error: {exc!s}"
        components.append(ComponentHealth("broker", broker_ok, detail))

        if self.database is not None:
            db_ok = await self.database.healthy()
            components.append(
                ComponentHealth("database", db_ok, "" if db_ok else "database is unreachable")
            )

        if self.last_loop_at is None:
            components.append(ComponentHealth("trading_loop", True, "not started yet"))
        else:
            age = (now - self.last_loop_at).total_seconds()
            ok = age <= self.heartbeat_timeout_seconds
            components.append(
                ComponentHealth(
                    "trading_loop",
                    ok,
                    "" if ok else f"no loop heartbeat for {age:.0f}s",
                )
            )

        report = HealthReport(components=components, checked_at=now)
        self.last_report = report
        return report
