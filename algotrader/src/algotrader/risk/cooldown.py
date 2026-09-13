"""Cooldowns after losses.

Losing streaks are when discipline fails, so the cooldown is mechanical: after
N consecutive losses the whole system stops opening positions for a configured
period, and an individual symbol is quarantined after it loses money.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ..config import RiskConfig
from ..utils.timeutils import utc_now


@dataclass
class CooldownState:
    until: datetime
    reason: str

    def active(self, now: datetime | None = None) -> bool:
        return (now or utc_now()) < self.until

    def remaining_minutes(self, now: datetime | None = None) -> float:
        delta = (self.until - (now or utc_now())).total_seconds() / 60.0
        return max(0.0, delta)


@dataclass
class CooldownTracker:
    config: RiskConfig
    consecutive_losses: int = 0
    global_cooldown: CooldownState | None = None
    symbol_cooldowns: dict[str, CooldownState] = field(default_factory=dict)

    # ------------------------------------------------------------------ #
    def record_trade_result(self, symbol: str, pnl: float, now: datetime | None = None) -> list[str]:
        """Update streak state after a closed trade. Returns triggered cooldowns."""
        now = now or utc_now()
        symbol = symbol.upper()
        triggered: list[str] = []
        if pnl < 0:
            self.consecutive_losses += 1
            minutes = self.config.symbol_cooldown_minutes_after_loss
            if minutes > 0:
                self.symbol_cooldowns[symbol] = CooldownState(
                    until=now + timedelta(minutes=minutes),
                    reason=f"loss on {symbol} ({pnl:.2f})",
                )
                triggered.append(f"symbol cooldown for {symbol}: {minutes}m")
            rule = self.config.consecutive_loss_cooldown
            if self.consecutive_losses >= rule.losses_to_trigger and rule.cooldown_minutes > 0:
                self.global_cooldown = CooldownState(
                    until=now + timedelta(minutes=rule.cooldown_minutes),
                    reason=f"{self.consecutive_losses} consecutive losses",
                )
                triggered.append(f"global cooldown: {rule.cooldown_minutes}m")
        else:
            self.consecutive_losses = 0
            minutes = self.config.symbol_cooldown_minutes_after_exit
            if minutes > 0:
                self.symbol_cooldowns[symbol] = CooldownState(
                    until=now + timedelta(minutes=minutes),
                    reason=f"recently exited {symbol}",
                )
        return triggered

    # ------------------------------------------------------------------ #
    def blocked_reason(self, symbol: str, now: datetime | None = None) -> str | None:
        now = now or utc_now()
        if self.global_cooldown and self.global_cooldown.active(now):
            return (
                f"global cooldown active ({self.global_cooldown.reason}), "
                f"{self.global_cooldown.remaining_minutes(now):.0f}m remaining"
            )
        state = self.symbol_cooldowns.get(symbol.upper())
        if state and state.active(now):
            return f"{symbol} cooldown active ({state.reason}), {state.remaining_minutes(now):.0f}m remaining"
        return None

    def purge_expired(self, now: datetime | None = None) -> None:
        now = now or utc_now()
        if self.global_cooldown and not self.global_cooldown.active(now):
            self.global_cooldown = None
        self.symbol_cooldowns = {s: c for s, c in self.symbol_cooldowns.items() if c.active(now)}

    def to_dict(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or utc_now()
        return {
            "consecutive_losses": self.consecutive_losses,
            "global_cooldown": (
                {
                    "reason": self.global_cooldown.reason,
                    "remaining_minutes": round(self.global_cooldown.remaining_minutes(now), 1),
                }
                if self.global_cooldown and self.global_cooldown.active(now)
                else None
            ),
            "symbol_cooldowns": {
                symbol: round(state.remaining_minutes(now), 1)
                for symbol, state in self.symbol_cooldowns.items()
                if state.active(now)
            },
        }
