"""Kill switch.

Any tripped reason blocks *new risk* immediately. Risk-reducing actions
(closing a position, cancelling a working order) stay allowed - that is the
whole point of the switch. Reasons must be cleared explicitly; nothing in the
system resets the switch on its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from ..enums import KillSwitchReason
from ..logging_setup import get_logger
from ..utils.timeutils import utc_now

log = get_logger(__name__)


@dataclass(frozen=True)
class KillSwitchEvent:
    reason: KillSwitchReason
    detail: str
    tripped_at: datetime
    cleared_at: datetime | None = None


@dataclass
class KillSwitch:
    """Blocks new orders while any reason is active."""

    reasons: dict[KillSwitchReason, str] = field(default_factory=dict)
    history: list[KillSwitchEvent] = field(default_factory=list)
    tripped_at: datetime | None = None
    on_change: Callable[[str, KillSwitchReason, str], None] | None = None

    @property
    def is_tripped(self) -> bool:
        return bool(self.reasons)

    @property
    def blocks_new_orders(self) -> bool:
        return self.is_tripped

    def trip(self, reason: KillSwitchReason, detail: str = "", now: datetime | None = None) -> bool:
        """Activate a reason. Returns True if this is a new activation."""
        now = now or utc_now()
        is_new = reason not in self.reasons
        self.reasons[reason] = detail
        if is_new:
            self.tripped_at = self.tripped_at or now
            self.history.append(KillSwitchEvent(reason=reason, detail=detail, tripped_at=now))
            log.error("kill_switch_tripped", reason=str(reason), detail=detail)
            if self.on_change:
                self.on_change("tripped", reason, detail)
        return is_new

    def clear(self, reason: KillSwitchReason, note: str = "", now: datetime | None = None) -> bool:
        """Clear one reason. Explicit, manual, and always audited."""
        if reason not in self.reasons:
            return False
        now = now or utc_now()
        self.reasons.pop(reason)
        for index, event in enumerate(self.history):
            if event.reason is reason and event.cleared_at is None:
                self.history[index] = KillSwitchEvent(
                    reason=event.reason,
                    detail=event.detail,
                    tripped_at=event.tripped_at,
                    cleared_at=now,
                )
                break
        if not self.reasons:
            self.tripped_at = None
        log.warning("kill_switch_cleared", reason=str(reason), note=note)
        if self.on_change:
            self.on_change("cleared", reason, note)
        return True

    def clear_all(self, note: str = "") -> list[KillSwitchReason]:
        cleared = list(self.reasons)
        for reason in cleared:
            self.clear(reason, note=note)
        return cleared

    def describe(self) -> str:
        if not self.reasons:
            return "clear"
        return "; ".join(f"{reason}: {detail}" for reason, detail in self.reasons.items())

    def to_dict(self) -> dict[str, Any]:
        return {
            "tripped": self.is_tripped,
            "tripped_at": self.tripped_at.isoformat() if self.tripped_at else None,
            "reasons": {str(reason): detail for reason, detail in self.reasons.items()},
            "history": [
                {
                    "reason": str(event.reason),
                    "detail": event.detail,
                    "tripped_at": event.tripped_at.isoformat(),
                    "cleared_at": event.cleared_at.isoformat() if event.cleared_at else None,
                }
                for event in self.history[-50:]
            ],
        }
