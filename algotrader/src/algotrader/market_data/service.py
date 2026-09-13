"""Market data service: fetching, caching and *validating* prices.

Bad data is the cheapest way to lose money, so nothing downstream sees a quote
or a bar series that has not been through :meth:`MarketDataService.assess_quote`
or :meth:`assess_series`. Failures here feed the kill switch rather than being
silently tolerated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable

from ..broker.base import BrokerAdapter, Quote
from ..config import MarketDataConfig, RiskConfig
from ..logging_setup import get_logger
from ..utils.timeutils import utc_now
from .cache import TTLCache
from .indicators import average_dollar_volume
from .series import BarSeries

log = get_logger(__name__)


@dataclass(frozen=True)
class DataQuality:
    """Verdict on a single symbol's data."""

    symbol: str
    ok: bool
    issues: tuple[str, ...] = ()
    spread_bps: float | None = None
    age_seconds: float | None = None

    def reason(self) -> str:
        return "; ".join(self.issues) if self.issues else "ok"


@dataclass
class MarketSnapshot:
    """Everything the decision pipeline needs for one cycle."""

    taken_at: datetime
    quotes: dict[str, Quote] = field(default_factory=dict)
    series: dict[str, BarSeries] = field(default_factory=dict)
    quality: dict[str, DataQuality] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    def tradable_symbols(self) -> list[str]:
        return sorted(s for s, q in self.quality.items() if q.ok)

    def is_usable(self, symbol: str) -> bool:
        verdict = self.quality.get(symbol.upper())
        return bool(verdict and verdict.ok)


class MarketDataService:
    def __init__(
        self,
        broker: BrokerAdapter,
        md_config: MarketDataConfig,
        risk_config: RiskConfig,
    ) -> None:
        self.broker = broker
        self.config = md_config
        self.risk = risk_config
        self._quote_cache: TTLCache[Quote] = TTLCache(ttl_seconds=md_config.cache_ttl_seconds)
        self._bar_cache: TTLCache[BarSeries] = TTLCache(ttl_seconds=900.0)

    # ------------------------------------------------------------------ #
    # fetching
    # ------------------------------------------------------------------ #
    async def get_quotes(self, symbols: Iterable[str], use_cache: bool = True) -> dict[str, Quote]:
        wanted = sorted({s.upper() for s in symbols})
        out: dict[str, Quote] = {}
        missing: list[str] = []
        for symbol in wanted:
            cached = self._quote_cache.get(symbol) if use_cache else None
            if cached is not None:
                out[symbol] = cached
            else:
                missing.append(symbol)
        if missing:
            fetched = await self.broker.get_quotes(missing)
            for symbol, quote in fetched.items():
                self._quote_cache.set(symbol, quote)
                out[symbol] = quote
        return out

    async def get_quote(self, symbol: str, use_cache: bool = True) -> Quote | None:
        quotes = await self.get_quotes([symbol], use_cache=use_cache)
        return quotes.get(symbol.upper())

    async def get_series(self, symbol: str, use_cache: bool = True) -> BarSeries:
        symbol = symbol.upper()
        if use_cache:
            cached = self._bar_cache.get(symbol)
            if cached is not None:
                return cached
        end = utc_now()
        start = end - timedelta(days=self.config.history_days)
        bars = await self.broker.get_history(symbol, start, end, interval="daily")
        series = BarSeries.from_bars(symbol, bars)
        self._bar_cache.set(symbol, series)
        return series

    async def snapshot(self, symbols: Iterable[str], use_cache: bool = True) -> MarketSnapshot:
        """Fetch + validate everything for one decision cycle."""
        wanted = sorted({s.upper() for s in symbols})
        snap = MarketSnapshot(taken_at=utc_now())
        try:
            snap.quotes = await self.get_quotes(wanted, use_cache=use_cache)
        except Exception as exc:  # broker errors must not kill the loop
            snap.errors.append(f"quote fetch failed: {exc!s}")
            log.warning("quote_fetch_failed", error=str(exc))

        for symbol in wanted:
            try:
                snap.series[symbol] = await self.get_series(symbol, use_cache=use_cache)
            except Exception as exc:
                snap.errors.append(f"history fetch failed for {symbol}: {exc!s}")
                log.warning("history_fetch_failed", symbol=symbol, error=str(exc))

        for symbol in wanted:
            snap.quality[symbol] = self.assess(
                symbol, snap.quotes.get(symbol), snap.series.get(symbol), now=snap.taken_at
            )
        return snap

    # ------------------------------------------------------------------ #
    # validation
    # ------------------------------------------------------------------ #
    def assess_quote(self, quote: Quote | None, now: datetime | None = None) -> tuple[list[str], DataQuality]:
        issues: list[str] = []
        if quote is None:
            return ["no quote available"], DataQuality(symbol="?", ok=False, issues=("no quote available",))
        now = now or utc_now()
        age = quote.age_seconds(now)
        if quote.mid is None or quote.mid <= 0:
            issues.append("missing or non-positive price")
        if quote.is_crossed:
            issues.append(f"crossed market bid={quote.bid} ask={quote.ask}")
        if age > self.config.quote_staleness_seconds:
            issues.append(f"stale quote ({age:.0f}s > {self.config.quote_staleness_seconds}s)")
        spread_bps = quote.spread_bps
        if spread_bps is None:
            issues.append("no two-sided market")
        elif spread_bps > self.risk.max_spread_bps:
            issues.append(f"spread {spread_bps:.1f}bps > {self.risk.max_spread_bps}bps")
        return issues, DataQuality(
            symbol=quote.symbol,
            ok=not issues,
            issues=tuple(issues),
            spread_bps=spread_bps,
            age_seconds=age,
        )

    def assess(
        self,
        symbol: str,
        quote: Quote | None,
        series: BarSeries | None,
        now: datetime | None = None,
    ) -> DataQuality:
        now = now or utc_now()
        issues, quote_verdict = self.assess_quote(quote, now=now)
        issues = list(issues)

        if series is None or len(series) == 0:
            issues.append("no price history")
        else:
            if len(series) < self.config.min_bars_required:
                issues.append(f"insufficient history ({len(series)} < {self.config.min_bars_required})")
            last_ts = series.last_timestamp
            if last_ts is not None:
                bar_age_days = (now - last_ts).days
                if bar_age_days > self.config.bar_staleness_days:
                    issues.append(f"stale history ({bar_age_days}d old)")
            if (series.closes <= 0).any():
                issues.append("non-positive close in history")

        # Liquidity floor is a data/tradability question, not a per-trade one.
        if series is not None and len(series) >= 20:
            adv = average_dollar_volume(series.closes, series.volumes, 20)
            if adv < self.risk.min_avg_dollar_volume:
                issues.append(
                    f"illiquid: 20d avg dollar volume {adv:,.0f} < {self.risk.min_avg_dollar_volume:,.0f}"
                )

        return DataQuality(
            symbol=symbol.upper(),
            ok=not issues,
            issues=tuple(issues),
            spread_bps=quote_verdict.spread_bps,
            age_seconds=quote_verdict.age_seconds,
        )

    def quote_is_fresh_enough_to_trade(self, quote: Quote, now: datetime | None = None) -> bool:
        return quote.age_seconds(now or utc_now()) <= self.config.max_quote_age_for_orders_seconds

    def cache_stats(self) -> dict[str, dict]:
        return {"quotes": self._quote_cache.stats(), "bars": self._bar_cache.stats()}

    def clear_cache(self) -> None:
        self._quote_cache.clear()
        self._bar_cache.clear()
