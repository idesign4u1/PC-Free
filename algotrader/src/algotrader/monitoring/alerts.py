"""Alerting.

Alerts go to structured logs and to the ``risk_events``/``system_events``
tables, and optionally to a webhook. Alerting must never raise into the trading
loop, so every delivery path is wrapped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

import httpx

from ..database.repository import Repository
from ..enums import RiskEventType
from ..logging_setup import get_logger
from ..utils.timeutils import utc_now

log = get_logger(__name__)


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class Alert:
    key: str
    message: str
    severity: AlertSeverity = AlertSeverity.WARNING
    symbol: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    raised_at: datetime = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "message": self.message,
            "severity": str(self.severity),
            "symbol": self.symbol,
            "payload": self.payload,
            "raised_at": self.raised_at.isoformat(),
        }


class AlertManager:
    """De-duplicates alerts and fans them out to log / database / webhook."""

    def __init__(
        self,
        repository: Repository | None = None,
        webhook_url: str = "",
        cooldown_minutes: int = 15,
        history_size: int = 200,
    ) -> None:
        self.repo = repository
        self.webhook_url = webhook_url
        self.cooldown = timedelta(minutes=cooldown_minutes)
        self.history: list[Alert] = []
        self._history_size = history_size
        self._last_sent: dict[str, datetime] = {}

    def _should_send(self, key: str, now: datetime) -> bool:
        last = self._last_sent.get(key)
        if last is not None and now - last < self.cooldown:
            return False
        self._last_sent[key] = now
        return True

    async def send(
        self,
        key: str,
        message: str,
        severity: AlertSeverity = AlertSeverity.WARNING,
        symbol: str | None = None,
        payload: dict[str, Any] | None = None,
        force: bool = False,
    ) -> bool:
        now = utc_now()
        if not force and not self._should_send(key, now):
            return False
        alert = Alert(
            key=key, message=message, severity=severity, symbol=symbol, payload=payload or {}, raised_at=now
        )
        self.history.append(alert)
        self.history = self.history[-self._history_size :]

        log_method = {
            AlertSeverity.INFO: log.info,
            AlertSeverity.WARNING: log.warning,
            AlertSeverity.CRITICAL: log.error,
        }[severity]
        log_method("alert", alert_key=key, message=message, symbol=symbol)

        if self.repo is not None:
            try:
                await self.repo.record_risk_event(
                    RiskEventType.LIMIT_BREACH if severity is AlertSeverity.CRITICAL else
                    RiskEventType.DATA_QUALITY,
                    detail=message,
                    severity=str(severity),
                    symbol=symbol,
                    payload=alert.payload | {"alert_key": key},
                )
            except Exception as exc:  # pragma: no cover - persistence must not break trading
                log.warning("alert_persist_failed", error=str(exc))

        if self.webhook_url:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(self.webhook_url, json=alert.to_dict())
            except Exception as exc:  # pragma: no cover - network best effort
                log.warning("alert_webhook_failed", error=str(exc))
        return True

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        return [alert.to_dict() for alert in self.history[-limit:][::-1]]
