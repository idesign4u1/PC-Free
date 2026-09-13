# algotrader

A risk-first autonomous trading platform for the **Tradier** brokerage API.

The system aims for high risk-adjusted returns while protecting capital first.
It makes no promise of profit: markets can and do lose money, execution can
fail, and every strategy in here can be wrong. What the platform guarantees is
process — deterministic risk rules that no strategy can bypass, a full audit
trail for every decision, and a default configuration that cannot place a
real-money order.

**Default startup is PAPER.** Live trading requires four independent switches
to be turned on by a human, plus a restart. Nothing in the code, the API, or
the dashboard can promote itself to live.

---

## 1. Architecture

```
                Tradier (sandbox | live)
                          │
                    broker/  ← BrokerAdapter interface (swap in IBKR/Alpaca
                          │      without touching anything above)
                  market_data/  fetch, cache, VALIDATE (stale, crossed, wide,
                          │     illiquid data is rejected, not traded on)
                     regime/  bull / bear / sideways / high-vol / low-vol / risk-off
                          │
                   strategy/  trend · momentum · breakout · mean-reversion ·
                          │   relative-strength → signal ∈ [-1,+1] + confidence 0-100
                    signals/  regime-weighted ensemble → OpportunityScore
                          │   (insufficient or conflicting evidence ⇒ no trade)
                  portfolio/  broker truth + local audit metadata, exposures,
                          │   correlation clusters, high-water mark
                       risk/  ★ FINAL AUTHORITY ★ limits, ATR stops, sizing,
                          │   drawdown tiers, cooldowns, kill switch, live gate
                  execution/  9-step pre-trade pipeline, idempotent orders,
                          │   partial fills, retries, reconciliation
                 monitoring/  health, alerts, execution quality, bounded adaptation
                   database/  every decision persisted for audit
                        api/  JSON API + dashboard
                   backtest/  same strategy + risk code, walk-forward validation
```

Core flow, once per cycle:

```
market data → regime → strategy ensemble → signal scoring → portfolio validation
→ RISK ENGINE → execution → position monitoring → performance learning
```

Position monitoring runs **before** new entries: protecting open capital comes
before deploying more of it.

### Risk engine has final authority

No strategy, score, or API call can open a position that the risk engine has
not approved. Every decision carries the list of checks that produced it
(`checks`, `rejection_reasons`, `sizing.caps`), and that payload is written to
the database with the order.

Two rules are hard-coded rather than configurable:

* **never average down** — an entry into a symbol that already holds a position
  in the same direction is refused;
* **never increase risk to recover losses** — drawdown tiers are validated at
  load time to be monotonically non-increasing in size.

### Drawdown response (configurable thresholds, `config/config.yaml`)

| Drawdown | Tier | Size multiplier | New positions | Minimum confidence |
|---------:|------|----------------:|---------------|-------------------:|
| 0% | NORMAL | 1.00× | yes | 55 |
| ≥3% | CAUTION | 0.70× | yes | 60 |
| ≥6% | DEFENSIVE | 0.40× | yes | 72 |
| ≥9% | LOCKDOWN | 0.00× | **no** | — |
| ≥12% | EMERGENCY | 0.00× | **no**, switches to EMERGENCY_MODE | — |

### Kill switch

Blocks **new risk** immediately (exits are always allowed) when any of these
occur: broker unavailable, stale/bad market data, abnormal spread, execution
errors, unexpected positions found at the broker, daily-loss limit, weekly-loss
limit, drawdown limit, internal consistency failure, or a manual trip. Reasons
clear only explicitly — via the API or a restart after the cause is fixed.

Modes: `SAFE_MODE` (analyse only), `PAPER_MODE` (default), `LIVE_MODE`,
`EMERGENCY_MODE` (risk-reducing orders only).

---

## 2. Files created

```
algotrader/
├── config/config.yaml               every trading & risk parameter
├── src/algotrader/
│   ├── config.py  enums.py  logging_setup.py  cli.py
│   ├── broker/        base.py (BrokerAdapter)  tradier.py  rate_limit.py
│   ├── market_data/   service.py  indicators.py  series.py  cache.py
│   ├── regime/        classifier.py
│   ├── strategy/      base.py  trend_following.py  momentum.py  breakout.py
│   │                  mean_reversion.py  relative_strength.py
│   ├── signals/       scoring.py
│   ├── portfolio/     models.py  manager.py
│   ├── risk/          engine.py  sizing.py  drawdown.py  cooldown.py
│   │                  kill_switch.py  live_gate.py
│   ├── execution/     engine.py  orders.py
│   ├── backtest/      engine.py  metrics.py  walkforward.py
│   ├── monitoring/    health.py  alerts.py  adaptation.py  execution_quality.py
│   ├── database/      base.py  models.py  repository.py
│   ├── api/           app.py  routes.py  security.py  dashboard.py
│   ├── trading/       loop.py
│   └── utils/         timeutils.py  ids.py
├── tests/             15 test modules, 214 tests
├── Dockerfile  docker-compose.yml  Makefile
├── pyproject.toml  requirements.txt  requirements-dev.txt
└── .env.example
```

---

## 3. Install and run

### Local (Python 3.12+)

```bash
cd algotrader

python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pip install -e .

cp .env.example .env        # then edit .env (see section 4)

algotrader check            # validates config + credentials + broker connectivity
algotrader init-db          # creates the schema
algotrader paper            # ← starts PAPER trading + dashboard on :8000
```

`make install && make check && make paper` does the same.

### Docker

```bash
cp .env.example .env        # edit it first
docker compose up --build -d
docker compose logs -f trader
```

Brings up PostgreSQL, Redis and the trader (paper mode) with the dashboard on
`http://localhost:8000`.

### Commands

| Command | What it does |
|---|---|
| `algotrader check` | validate config, credentials, broker connectivity. Sends no orders |
| `algotrader init-db` | create the database schema |
| `algotrader paper` | trading loop **and** dashboard/API |
| `algotrader trade [--cycles N]` | trading loop only |
| `algotrader api` | dashboard/API only — never trades |
| `algotrader backtest --days 750 [--symbols AAPL,MSFT] [--output run.json]` | backtest on Tradier history |
| `algotrader backtest --walk-forward --train-days 365 --test-days 90` | walk-forward / out-of-sample analysis |
| `algotrader live-gate` | report on readiness for live trading |
| `algotrader config-dump` | effective configuration, secrets redacted |

---

## 4. Environment variables

Secrets live **only** in the environment; `config/config.yaml` holds no
credentials and logs are redacted.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TRADIER_PAPER_TOKEN` | yes | – | sandbox access token |
| `TRADIER_PAPER_ACCOUNT_ID` | yes | – | sandbox account number |
| `TRADIER_LIVE_TOKEN` | no | empty | leave empty until the live gate passes |
| `TRADIER_LIVE_ACCOUNT_ID` | no | empty | as above |
| `ENABLE_LIVE_TRADING` | no | `false` | the real-money switch — one of four required |
| `DATABASE_URL` | no | local PostgreSQL | `sqlite+aiosqlite:///./algotrader.sqlite` also works |
| `REDIS_URL` | no | empty | optional |
| `CONFIG_PATH` | no | `config/config.yaml` | trading parameters |
| `API_HOST` / `API_PORT` | no | `0.0.0.0` / `8000` | |
| `API_TOKEN` | for mutations | empty | without it, every state-changing endpoint is **disabled** |
| `LOG_LEVEL` / `LOG_JSON` | no | `INFO` / `true` | structured logging |
| `ALERT_WEBHOOK_URL` | no | empty | alerts POSTed as JSON |

Endpoints: paper `https://sandbox.tradier.com`, live `https://api.tradier.com`.
They are selected by the resolved environment, never mixed.

---

## 5. Starting PAPER trading

1. Create a Tradier sandbox account, then copy the sandbox **access token** and
   **account number** into `.env` as `TRADIER_PAPER_TOKEN` /
   `TRADIER_PAPER_ACCOUNT_ID`.
2. Set `API_TOKEN` to a long random string.
3. Confirm the configuration is paper: `config/config.yaml` → `system.mode:
   PAPER_MODE`, `live_gate.enabled: false` (both are the defaults).
4. `algotrader check` — expect `"broker_environment": "PAPER"`,
   `"live_trading_enabled": false` and `"broker_connectivity": "ok"`.
5. `algotrader init-db`
6. `algotrader paper`
7. Open `http://localhost:8000` for the dashboard, or:

```bash
curl localhost:8000/health
curl localhost:8000/api/status
curl localhost:8000/api/live-gate
curl -X POST localhost:8000/api/trading/cycle -H "X-API-Token: $API_TOKEN"
```

The loop runs every `system.loop_interval_seconds` (60s), trades only while the
market is open, and skips the first 5 and last 10 minutes of the session.

### Monitoring endpoints

| Endpoint | Contents |
|---|---|
| `GET /` | dashboard |
| `GET /health` | component health (broker, database, loop heartbeat) |
| `GET /api/status` | mode, environment, market state, regime, portfolio, risk, last cycle |
| `GET /api/portfolio`, `/api/positions` | equity, cash, exposures, open positions |
| `GET /api/orders`, `/api/trades`, `/api/trades/{id}` | orders, trades, full per-trade reasoning |
| `GET /api/pnl` | daily P&L history, drawdown, high-water mark, statistics |
| `GET /api/risk` | limit utilisation, kill-switch state, recent risk events |
| `GET /api/regime`, `/api/signals`, `/api/strategies` | regime, live scores, strategy weights/performance |
| `GET /api/execution-quality` | expected vs actual fills (paper fidelity) |
| `GET /api/live-gate` | live-readiness criteria and what is blocking |
| `POST /api/kill-switch/trip\|clear`, `/api/mode`, `/api/trading/cycle`, `/api/trading/flatten`, `/api/backtest` | token required |

---

## 6. Going live (and why it will not happen by accident)

`POST /api/mode {"mode": "LIVE_MODE"}` returns **403**. Live requires all of:

1. every criterion in `GET /api/live-gate` passing — minimum paper trades,
   minimum operating period, maximum paper drawdown, positive expectancy,
   minimum profit factor, win rate, Sharpe, and healthy system checks;
2. `live_gate.enabled: true` in `config/config.yaml`;
3. `system.mode: LIVE_MODE` in `config/config.yaml`;
4. `ENABLE_LIVE_TRADING=true` plus `TRADIER_LIVE_TOKEN` and
   `TRADIER_LIVE_ACCOUNT_ID` in the environment;
5. a restart.

If any one is missing the platform silently resolves back to the sandbox. Paper
and live run **identical** trading logic — only the base URL, credentials and
account differ.

---

## 7. Backtesting

The backtester imports the same strategy, scoring and risk modules the live
loop uses. It models commissions, half-spread, configurable slippage, next-open
fills for signals generated on the close, intrabar stop checks (stop assumed
first when a bar touches both stop and target), gap-through fills at the open,
and a cap on participation in a bar's volume. Indicators are computed only from
bars up to and including the current one, so there is no look-ahead.

```bash
algotrader backtest --days 750 --output backtests/run.json
algotrader backtest --walk-forward --train-days 365 --test-days 90
```

Metrics: CAGR, total return, Sharpe, Sortino, Calmar, max drawdown, win rate,
profit factor, expectancy (cash and R), average/largest win and loss, average
holding period, exposure, commission paid, trade count. Walk-forward reports
per-fold in-sample and out-of-sample results plus a walk-forward efficiency
ratio; below ~0.5 it warns about overfitting.

---

## 8. Audit trail

Every decision is persisted. Sixteen tables cover symbols, market observations,
regime records, per-strategy signals, opportunity scores (including *why a
trade was rejected*), orders, fills, trades, position and portfolio snapshots,
daily P&L, risk events, strategy performance, execution quality, system events
and configuration history.

For every trade the database stores **why it was entered** (`entry_reason`, the
scored contribution of each strategy), **why that size** (`sizing_reason`,
including every cap considered and which one bound), **why that stop**
(`stop_reason`, ATR inputs and any distance cap), **why it was exited**
(`exit_reason`/`exit_detail`), plus the regime and the complete risk state at
decision time. `GET /api/trades/{id}` returns exactly that.

---

## 9. Tests

```bash
make test          # or: .venv/bin/python -m pytest
```

```
214 passed in 110s
```

| Module | Tests | Focus |
|---|---:|---|
| `test_broker_tradier.py` | 12 | request/response mapping, HTTP-200 rejections, duplicate suppression, tag reconciliation after timeout, OTOCO payload, auth/5xx/rate-limit handling |
| `test_indicators.py` | 11 | indicator maths, no look-ahead in the Donchian channel, short-input safety |
| `test_market_data_service.py` | 9 | stale/crossed/wide/illiquid data rejected, broker failures contained |
| `test_regime.py` | 6 | bull, bear, sideways, crash→risk-off, high-vol, insufficient data → defensive |
| `test_strategies.py` | 12 | direction, normalisation, "no falling knives", volume confirmation, containment of strategy errors |
| `test_signal_scoring.py` | 11 | agreement required, conflict refused, low confidence refused, ranking |
| `test_risk_engine.py` | 45 | every limit, drawdown tiers, no averaging down, cooldowns, stops/trailing, kill switch, JSON-safe audit |
| `test_portfolio.py` | 10 | exposure/drawdown maths, broker reconciliation, correlation clusters |
| `test_execution_engine.py` | 19 | full pre-trade pipeline, idempotency, partial fills, bracket fallback, slippage, kill-switch blocks entries but not exits |
| `test_trading_loop.py` | 14 | end-to-end cycles, stop-out, cooldown, unexpected positions, broker outage/recovery, restart restores state |
| `test_backtest.py` | 12 | trade generation, costs, stops, risk caps, no look-ahead, metric maths |
| `test_walkforward.py` | 4 | fold construction, candidate selection, insufficient history |
| `test_api.py` | 27 | every endpoint, auth, redaction, **live mode cannot be enabled over the API** |
| `test_config.py` | 11 | conservative defaults, four-switch live resolution, tier monotonicity |
| `test_live_gate.py` | 5 | each criterion blocks; eligible ≠ enabled |
| `test_adaptation.py` | 6 | weight changes stay inside the configured band |

No test touches the network: the Tradier adapter is exercised through mocked
HTTP (`respx`) and the rest through an in-memory fake broker and SQLite.

---

## 10. Limitations

Known and deliberate, in rough order of importance:

1. **No profit claim.** Historical or paper results do not predict future
   results. The default parameters are conservative starting points, not a
   validated edge — treat them as something to test, not to trust.
2. **Not validated against a live Tradier account.** The adapter was built
   against the documented v1 contract and is covered by mocked tests; the
   network was unavailable in the build environment, so the sandbox handshake
   has not been exercised. Run `algotrader check` first, then a paper session,
   before believing anything.
3. **Daily bars only.** Decisions use daily OHLCV plus live quotes. There is no
   intraday bar handling and no WebSocket/streaming support, so the loop polls
   (default 60s) and is rate-limit aware rather than event-driven.
4. **Equities only, long only by default.** Options, futures and crypto are not
   implemented. `signals.long_only: true` disables shorts; the risk engine
   supports short sizing but short borrow, locate and margin rules are not
   modelled.
5. **Bracket orders depend on the venue.** OTOCO is sent when configured and
   supported; if the broker rejects it the system falls back to a plain entry
   and manages the stop itself, which means a stop can be missed while the
   process is down. Run it as a supervised service.
6. **Trailing stops are maintained locally.** Tradier has no native equity
   trailing stop, so the platform amends its own protective level each cycle.
7. **Backtest fidelity.** Next-open fills, a fixed half-spread and constant
   slippage in basis points are approximations. There is no queue modelling, no
   partial-fill simulation (off by default), no borrow costs, no dividends or
   corporate actions, and no survivorship-bias-free universe — the universe is
   whatever you configure today, so long backtests inherit that bias.
8. **Regime classification is heuristic**, based on the benchmark's moving
   averages, regression slope, realised volatility and drawdown. It is
   explainable rather than optimal, and it lags at turning points.
9. **Adaptation is deliberately weak.** Weights move at most ±0.10 around their
   configured values, only with enough closed trades, and only inside absolute
   bounds. There is no self-modifying strategy code, by design.
10. **Schema is created with `create_all`.** There is no migration tool yet, so
    schema changes need manual handling on an existing database.
11. **Single-process design.** One trading loop per account. Running two
    against the same account would double orders; the duplicate guard protects
    against retries, not against a second deployment.
12. **API auth is a single shared token** over whatever transport you terminate.
    Put it behind TLS and your own network controls; there is no user model,
    rate limiting or audit of API callers beyond the system event log.
