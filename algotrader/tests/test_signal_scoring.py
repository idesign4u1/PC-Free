"""Ensemble scoring: agreement is required, conflict is refused."""

from __future__ import annotations

import pytest

from algotrader.enums import Regime, SignalDirection, VolatilityRegime
from algotrader.regime.classifier import RegimeState
from algotrader.signals import SignalAggregator
from algotrader.strategy.base import Signal


def regime_state(regime=Regime.BULL_TREND, sufficient=True):
    return RegimeState(
        regime=regime,
        volatility_regime=VolatilityRegime.NORMAL,
        trend_regime=Regime.BULL_TREND,
        confidence=80.0,
        trend_strength=0.5,
        realized_vol=0.15,
        long_run_vol=0.15,
        benchmark_drawdown=0.01,
        atr_pct=0.015,
        symbol="SPY",
        sufficient_data=sufficient,
    )


def sig(strategy, value, confidence=80.0, atr=2.0):
    return Signal(symbol="AAPL", strategy=strategy, value=value, confidence=confidence, atr=atr)


@pytest.fixture()
def aggregator(config):
    return SignalAggregator(config.strategies, config.signals)


def test_strong_agreement_is_actionable(aggregator):
    signals = [
        sig("trend_following", 0.8),
        sig("momentum", 0.7),
        sig("relative_strength", 0.6),
        sig("breakout", 0.5),
    ]
    score = aggregator.score("AAPL", signals, regime_state())
    assert score.actionable
    assert score.direction is SignalDirection.LONG
    assert score.score > 0.4
    assert score.agreeing >= 3
    assert score.atr == pytest.approx(2.0)


def test_conflicting_evidence_is_refused(aggregator):
    signals = [
        sig("trend_following", 0.8),
        sig("momentum", -0.8),
        sig("mean_reversion", -0.7),
        sig("breakout", 0.6),
    ]
    score = aggregator.score("AAPL", signals, regime_state())
    assert not score.actionable
    assert any("conflicting" in r or "score" in r for r in score.rejection_reasons)


def test_insufficient_evidence_is_refused(aggregator):
    score = aggregator.score("AAPL", [sig("trend_following", 0.9)], regime_state())
    assert not score.actionable
    assert any("agree" in r for r in score.rejection_reasons)


def test_no_signals_is_refused(aggregator):
    score = aggregator.score("AAPL", [], regime_state())
    assert not score.actionable
    assert score.rejection_reasons == ("no strategy produced a signal",)


def test_low_confidence_is_refused(aggregator):
    signals = [sig(name, 0.9, confidence=20.0) for name in ("trend_following", "momentum", "breakout")]
    score = aggregator.score("AAPL", signals, regime_state())
    assert not score.actionable
    assert any("confidence" in r for r in score.rejection_reasons)


def test_short_signals_blocked_when_long_only(aggregator):
    signals = [sig(name, -0.9) for name in ("trend_following", "momentum", "relative_strength")]
    score = aggregator.score("AAPL", signals, regime_state())
    assert not score.actionable
    assert any("long_only" in r for r in score.rejection_reasons)


def test_unknown_regime_blocks_trading(aggregator):
    signals = [sig(name, 0.9) for name in ("trend_following", "momentum", "relative_strength")]
    score = aggregator.score("AAPL", signals, regime_state(sufficient=False))
    assert not score.actionable
    assert any("regime" in r for r in score.rejection_reasons)


def test_risk_off_regime_damps_the_score(aggregator):
    signals = [sig(name, 0.8) for name in ("trend_following", "momentum", "breakout")]
    bull = aggregator.score("AAPL", signals, regime_state(Regime.BULL_TREND))
    risk_off = aggregator.score("AAPL", signals, regime_state(Regime.RISK_OFF))
    # Same raw signals, but risk-off multipliers must not make trading *easier*.
    assert risk_off.confidence <= bull.confidence
    assert sum(c.effective_weight for c in risk_off.contributions) < sum(
        c.effective_weight for c in bull.contributions
    )


def test_weight_overrides_are_respected(aggregator):
    signals = [sig("trend_following", 0.9), sig("momentum", 0.1), sig("breakout", 0.1)]
    before = aggregator.score("AAPL", signals, regime_state()).score
    aggregator.set_weight_overrides({"trend_following": 0.9, "momentum": 0.05, "breakout": 0.05})
    after = aggregator.score("AAPL", signals, regime_state()).score
    assert after > before


def test_ranking_prefers_conviction_and_confidence(aggregator):
    strong = aggregator.score(
        "STRONG", [sig(n, 0.9, 90) for n in ("trend_following", "momentum", "breakout")], regime_state()
    )
    weak = aggregator.score(
        "WEAK", [sig(n, 0.45, 70) for n in ("trend_following", "momentum", "breakout")], regime_state()
    )
    ranked = aggregator.rank([weak, strong])
    assert [s.symbol for s in ranked][0] == "STRONG"


def test_score_is_fully_auditable(aggregator):
    signals = [sig(n, 0.7) for n in ("trend_following", "momentum", "relative_strength")]
    payload = aggregator.score("AAPL", signals, regime_state()).to_dict()
    assert payload["contributions"] and payload["regime"] == "BULL_TREND"
    assert {"strategy", "effective_weight", "weighted_value"} <= set(payload["contributions"][0])
