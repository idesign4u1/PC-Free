"""Timezone helpers. All persisted timestamps are timezone-aware UTC."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MARKET_TZ = ZoneInfo("America/New_York")
REGULAR_OPEN = time(9, 30)
REGULAR_CLOSE = time(16, 0)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def market_now(tz: ZoneInfo = MARKET_TZ) -> datetime:
    return datetime.now(tz)


def trading_day_bounds(moment: datetime | None = None, tz: ZoneInfo = MARKET_TZ) -> tuple[datetime, datetime]:
    """UTC bounds of the regular session for the local trading day of `moment`."""
    local = (moment or utc_now()).astimezone(tz)
    open_local = datetime.combine(local.date(), REGULAR_OPEN, tzinfo=tz)
    close_local = datetime.combine(local.date(), REGULAR_CLOSE, tzinfo=tz)
    return to_utc(open_local), to_utc(close_local)


def week_start(moment: datetime | None = None, tz: ZoneInfo = MARKET_TZ) -> datetime:
    """UTC timestamp of Monday 00:00 local time for the week of `moment`."""
    local = (moment or utc_now()).astimezone(tz)
    monday = local.date() - timedelta(days=local.weekday())
    return to_utc(datetime.combine(monday, time(0, 0), tzinfo=tz))


def is_same_trading_day(a: datetime, b: datetime, tz: ZoneInfo = MARKET_TZ) -> bool:
    return a.astimezone(tz).date() == b.astimezone(tz).date()


def local_trading_date(moment: datetime | None = None, tz: ZoneInfo = MARKET_TZ) -> date:
    return (moment or utc_now()).astimezone(tz).date()


def minutes_between(a: datetime, b: datetime) -> float:
    return abs((to_utc(a) - to_utc(b)).total_seconds()) / 60.0
