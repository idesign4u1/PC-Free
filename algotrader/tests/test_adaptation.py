"""Weight adaptation stays inside its configured band."""

from __future__ import annotations

import pytest

from algotrader.database import Database, Repository
from algotrader.monitoring.adaptation import StrategyAdapter


@pytest.fixture()
async def repo():
    database = Database("sqlite+aiosqlite:///:memory:")
    await database.create_all()
    yield Repository(database)
    await database.close()


async def seed_trades(repo: Repository, strategy: str, r_multiple: float, count: int) -> None:
    for i in range(count):
        trade = await repo.open_trade(
            symbol=f"S{i}",
            quantity=10,
            entry_price=100.0,
            risk_per_share=5.0,
            strategy_scores={
                "contributions": [{"strategy": strategy, "effective_weight": 0.3}]
            },
        )
        await repo.close_trade(
            trade.id,
            exit_price=100.0 + r_multiple * 5.0,
            realized_pnl=r_multiple * 5.0 * 10,
            exit_reason="TAKE_PROFIT" if r_multiple > 0 else "STOP_LOSS",
        )


async def test_insufficient_evidence_leaves_weights_untouched(config, repo):
    await seed_trades(repo, "momentum", 1.0, 3)
    adapter = StrategyAdapter(config.strategies, config.adaptation, repo)
    proposals = {p.strategy: p for p in await adapter.propose_weights()}
    assert proposals["momentum"].proposed_weight == config.strategies.weights["momentum"]
    assert "insufficient evidence" in proposals["momentum"].reason


async def test_good_performance_increases_weight_within_bounds(config, repo):
    await seed_trades(repo, "momentum", 1.5, 30)
    adapter = StrategyAdapter(config.strategies, config.adaptation, repo)
    proposals = {p.strategy: p for p in await adapter.propose_weights()}
    base = config.strategies.weights["momentum"]
    proposed = proposals["momentum"].proposed_weight
    assert proposed > base
    assert proposed <= base + config.adaptation.max_weight_delta + 1e-9


async def test_bad_performance_reduces_weight_within_bounds(config, repo):
    await seed_trades(repo, "breakout", -1.0, 30)
    adapter = StrategyAdapter(config.strategies, config.adaptation, repo)
    proposals = {p.strategy: p for p in await adapter.propose_weights()}
    base = config.strategies.weights["breakout"]
    proposed = proposals["breakout"].proposed_weight
    assert proposed < base
    assert proposed >= base - config.adaptation.max_weight_delta - 1e-9
    assert proposed >= config.adaptation.min_weight


async def test_weights_never_leave_the_absolute_bounds(config, repo):
    await seed_trades(repo, "trend_following", 50.0, 30)      # absurd expectancy
    adapter = StrategyAdapter(config.strategies, config.adaptation, repo)
    for proposal in await adapter.propose_weights():
        assert config.adaptation.min_weight <= proposal.proposed_weight <= config.adaptation.max_weight


async def test_disabled_adaptation_proposes_nothing(config, repo):
    adaptation = config.adaptation.model_copy(update={"enabled": False})
    adapter = StrategyAdapter(config.strategies, adaptation, repo)
    assert await adapter.propose_weights() == []


async def test_applied_weights_are_persisted(config, repo):
    await seed_trades(repo, "momentum", 1.0, 30)
    adapter = StrategyAdapter(config.strategies, config.adaptation, repo)
    overrides = await adapter.apply(await adapter.propose_weights())
    assert set(overrides) == set(config.strategies.weights)
    stored = {row.strategy: row.applied_weight for row in await repo.strategy_performance()}
    assert stored["momentum"] == pytest.approx(overrides["momentum"])
