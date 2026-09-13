"""Minimal server-rendered dashboard.

Deliberately dependency-free: one HTML page that polls the JSON API. It shows
what a risk-first system should show first - drawdown, risk utilisation and the
kill switch - before it shows P&L.
"""

from __future__ import annotations

DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>algotrader</title>
<style>
  :root { color-scheme: light dark; --ok:#1a7f37; --warn:#9a6700; --bad:#b42318; --line:#d8dee4; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 24px; background: #f6f8fa; color: #1f2328; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #656d76; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
             color: #656d76; margin: 0 0 8px; font-weight: 600; }
  .metric { font-size: 24px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; font-size: 13px; padding: 3px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: #656d76; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
          font-weight: 600; border: 1px solid var(--line); }
  .bar { height: 6px; background: #eaeef2; border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .bar > i { display: block; height: 100%; background: var(--ok); }
  .wide { grid-column: 1 / -1; }
  @media (prefers-color-scheme: dark) {
    body { background:#0d1117; color:#e6edf3; } .card { background:#161b22; border-color:#30363d; }
    th,td { border-color:#30363d; } .bar { background:#30363d; }
  }
</style>
</head>
<body>
<h1>algotrader</h1>
<div class="sub" id="subtitle">loading...</div>
<div class="grid">
  <div class="card"><h2>Mode</h2><div class="metric" id="mode">-</div>
    <div class="row"><span>Environment</span><b id="environment">-</b></div>
    <div class="row"><span>Market</span><b id="market">-</b></div>
    <div class="row"><span>Kill switch</span><b id="killswitch">-</b></div></div>
  <div class="card"><h2>Equity</h2><div class="metric" id="equity">-</div>
    <div class="row"><span>Cash</span><b id="cash">-</b></div>
    <div class="row"><span>Buying power</span><b id="bp">-</b></div>
    <div class="row"><span>Exposure</span><b id="exposure">-</b></div></div>
  <div class="card"><h2>P&amp;L</h2><div class="metric" id="dailypnl">-</div>
    <div class="row"><span>Unrealised</span><b id="unrealised">-</b></div>
    <div class="row"><span>Weekly</span><b id="weekly">-</b></div>
    <div class="row"><span>High-water mark</span><b id="hwm">-</b></div></div>
  <div class="card"><h2>Drawdown</h2><div class="metric" id="drawdown">-</div>
    <div class="row"><span>Tier</span><b id="tier">-</b></div>
    <div class="row"><span>Size multiplier</span><b id="sizemult">-</b></div>
    <div class="row"><span>New positions</span><b id="allownew">-</b></div></div>
  <div class="card"><h2>Regime</h2><div class="metric" id="regime">-</div>
    <div class="row"><span>Volatility</span><b id="volregime">-</b></div>
    <div class="row"><span>Confidence</span><b id="regimeconf">-</b></div>
    <div class="row"><span>Benchmark drawdown</span><b id="benchdd">-</b></div></div>
  <div class="card"><h2>Risk utilisation</h2><div id="risk"></div></div>
  <div class="card wide"><h2>Positions</h2><table id="positions"></table></div>
  <div class="card wide"><h2>Recent trades</h2><table id="trades"></table></div>
  <div class="card wide"><h2>Latest signals</h2><table id="signals"></table></div>
</div>
<script>
const money = v => (v === null || v === undefined) ? '-' :
  v.toLocaleString(undefined, {style:'currency', currency:'USD', maximumFractionDigits:0});
const pct = v => (v === null || v === undefined) ? '-' : (v*100).toFixed(2) + '%';
const cls = v => v > 0 ? 'ok' : (v < 0 ? 'bad' : '');
const table = (el, cols, rows) => {
  el.innerHTML = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>' +
    (rows.length ? rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('')
                 : `<tr><td colspan="${cols.length}">none</td></tr>`);
};
async function refresh() {
  try {
    const [status, positions, trades, signals] = await Promise.all([
      fetch('api/status').then(r => r.json()),
      fetch('api/positions').then(r => r.json()),
      fetch('api/trades?limit=10').then(r => r.json()),
      fetch('api/signals').then(r => r.json()),
    ]);
    const p = status.portfolio, r = status.risk, tier = r.drawdown_tier;
    document.getElementById('subtitle').textContent =
      `${status.broker} | config ${status.config_hash.slice(0,12)} | updated ${new Date().toLocaleTimeString()}`;
    document.getElementById('mode').textContent = status.mode;
    document.getElementById('environment').textContent = status.environment;
    document.getElementById('market').textContent = status.market.is_open ? 'open' : status.market.state;
    const ks = document.getElementById('killswitch');
    ks.textContent = r.kill_switch.tripped ? 'TRIPPED' : 'clear';
    ks.className = r.kill_switch.tripped ? 'bad' : 'ok';
    document.getElementById('equity').textContent = money(p.equity);
    document.getElementById('cash').textContent = money(p.cash);
    document.getElementById('bp').textContent = money(p.buying_power);
    document.getElementById('exposure').textContent = pct(p.exposure_pct);
    const d = document.getElementById('dailypnl');
    d.textContent = money(p.daily_pnl) + ' (' + pct(p.daily_pnl_pct) + ')';
    d.className = 'metric ' + cls(p.daily_pnl);
    document.getElementById('unrealised').textContent = money(p.unrealized_pnl);
    document.getElementById('weekly').textContent = pct(p.weekly_pnl_pct);
    document.getElementById('hwm').textContent = money(p.high_water_mark);
    const dd = document.getElementById('drawdown');
    dd.textContent = pct(p.drawdown);
    dd.className = 'metric ' + (p.drawdown > 0.05 ? 'bad' : (p.drawdown > 0.02 ? 'warn' : ''));
    document.getElementById('tier').textContent = tier.tier;
    document.getElementById('sizemult').textContent = tier.size_multiplier + 'x';
    document.getElementById('allownew').textContent = tier.allow_new_positions ? 'allowed' : 'blocked';
    const reg = status.regime || {};
    document.getElementById('regime').textContent = reg.regime || '-';
    document.getElementById('volregime').textContent = reg.volatility_regime || '-';
    document.getElementById('regimeconf').textContent = reg.confidence != null ? reg.confidence.toFixed(0) : '-';
    document.getElementById('benchdd').textContent = reg.benchmark_drawdown != null ? pct(reg.benchmark_drawdown) : '-';
    document.getElementById('risk').innerHTML = ['gross_exposure','open_positions','daily_loss','weekly_loss','drawdown','daily_risk_budget']
      .map(k => { const v = Math.min(1, r[k] || 0);
        return `<div class="row"><span>${k.replace(/_/g,' ')}</span><b>${(v*100).toFixed(0)}%</b></div>
                <div class="bar"><i style="width:${v*100}%;background:${v>0.8?'#b42318':(v>0.5?'#9a6700':'#1a7f37')}"></i></div>`; }).join('');
    table(document.getElementById('positions'),
      ['Symbol','Qty','Avg','Last','Value','Unrealised','Stop','R'],
      positions.positions.map(x => [x.symbol, x.quantity, x.average_price, x.current_price,
        money(x.market_value), `<span class="${cls(x.unrealized_pnl)}">${money(x.unrealized_pnl)}</span>`,
        x.stop_price ?? '-', x.r_multiple]));
    table(document.getElementById('trades'),
      ['Symbol','Status','Qty','Entry','Exit','P&L','Reason','Regime'],
      trades.trades.map(t => [t.symbol, t.status, t.quantity, t.entry_price, t.exit_price ?? '-',
        `<span class="${cls(t.realized_pnl)}">${t.realized_pnl != null ? money(t.realized_pnl) : '-'}</span>`,
        t.exit_reason ?? '-', t.regime_at_entry]));
    table(document.getElementById('signals'),
      ['Symbol','Score','Confidence','Direction','Actionable','Why not'],
      signals.signals.map(s => [s.symbol, s.score, s.confidence, s.direction,
        s.actionable ? '<span class="ok">yes</span>' : 'no', (s.rejection_reasons||[]).join('; ')]));
  } catch (err) {
    document.getElementById('subtitle').textContent = 'error: ' + err;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
"""
