"""Walk-forward analysis: selection in-sample, measurement out-of-sample."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

from algotrader.backtest.walkforward import walk_forward
from algotrader.broker.base import Bar


def bars(symbol: str, closes: list[float], volume: float = 5_000_000.0) -> list[Bar]:
    start = datetime(2022, 1, 3, tzinfo=timezone.utc)
    out: list[Bar] = []
    previous = closes[0]
    for i, close in enumerate(closes):
        out.append(
            Bar(
                symbol=symbol,
                timestamp=start + timedelta(days=i),
                open=previous,
                high=max(close, previous) * 1.004,
                low=min(close, previous) * 0.996,
                close=close,
                volume=volume,
            )
        )
        previous = close
    return out


rng = np.random.default_rng(11)
N = 900
TREND = list(100 * np.exp(np.cumsum(rng.normal(0.0009, 0.011, N))))
BENCH = list(400 * np.exp(np.cumsum(rng.normal(0.0004, 0.008, N))))


def wf_config(config):
    universe = config.universe.model_copy(
        update={"symbols": ["AAA"], "sectors": {"AAA": "technology", "SPY": "index"}, "benchmark": "SPY"}
    )
    return config.model_copy(update={"universe": universe})


def test_walk_forward_produces_out_of_sample_folds(config):
    data = {"AAA": bars("AAA", TREND), "SPY": bars("SPY", BENCH)}
    result = walk_forward(wf_config(config), data, "SPY", train_days=400, test_days=150)
    assert result.folds, result.notes
    for fold in result.folds:
        assert fold.test_start >= fold.train_end          # no overlap: test follows training
        assert fold.out_of_sample is not None
        assert fold.in_sample is not None
    assert isinstance(result.efficiency, float)
    assert "walk_forward_efficiency" in result.to_dict()


def test_walk_forward_selects_between_candidate_weightings(config):
    data = {"AAA": bars("AAA", TREND), "SPY": bars("SPY", BENCH)}
    candidates = [
        {"trend_following": 0.5, "momentum": 0.3, "breakout": 0.1, "mean_reversion": 0.05,
         "relative_strength": 0.05},
        {"trend_following": 0.1, "momentum": 0.1, "breakout": 0.1, "mean_reversion": 0.6,
         "relative_strength": 0.1},
    ]
    result = walk_forward(
        wf_config(config), data, "SPY", train_days=400, test_days=150, candidate_weights=candidates
    )
    assert result.folds
    for fold in result.folds:
        assert fold.selected_weights in candidates


def test_insufficient_history_returns_a_clear_note(config):
    data = {"AAA": bars("AAA", TREND[:200]), "SPY": bars("SPY", BENCH[:200])}
    result = walk_forward(wf_config(config), data, "SPY", train_days=400, test_days=150)
    assert result.folds == []
    assert any("not enough history" in note for note in result.notes)


def test_no_data_is_handled(config):
    result = walk_forward(wf_config(config), {}, "SPY")
    assert result.folds == [] and "no data supplied" in result.notes
