"""Vectorised technical indicators.

Every function takes and returns plain numpy arrays. Arrays are returned with
``NaN`` in the warm-up region so that index ``i`` of the output always refers to
bar ``i`` of the input - this is what keeps the backtester free of look-ahead
bias: a value at index ``i`` is computed strictly from bars ``<= i``.
"""

from __future__ import annotations

import numpy as np

TRADING_DAYS = 252


def _as_array(values) -> np.ndarray:
    return np.asarray(values, dtype=float)


def sma(values, period: int) -> np.ndarray:
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if period <= 0 or arr.size < period:
        return out
    cumsum = np.cumsum(np.insert(arr, 0, 0.0))
    out[period - 1 :] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def ema(values, period: int) -> np.ndarray:
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if period <= 0 or arr.size < period:
        return out
    alpha = 2.0 / (period + 1.0)
    out[period - 1] = arr[:period].mean()
    for i in range(period, arr.size):
        out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
    return out


def _windows(arr: np.ndarray, period: int) -> np.ndarray:
    """Sliding windows over `arr`; shape (n - period + 1, period)."""
    return np.lib.stride_tricks.sliding_window_view(arr, period)


def rolling_std(values, period: int) -> np.ndarray:
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if arr.size < period or period < 2:
        return out
    out[period - 1 :] = _windows(arr, period).std(ddof=1, axis=1)
    return out



def true_range(high, low, close) -> np.ndarray:
    h, l, c = _as_array(high), _as_array(low), _as_array(close)
    tr = np.full(h.shape, np.nan)
    if h.size == 0:
        return tr
    tr[0] = h[0] - l[0]
    prev_close = c[:-1]
    tr[1:] = np.maximum.reduce(
        [h[1:] - l[1:], np.abs(h[1:] - prev_close), np.abs(l[1:] - prev_close)]
    )
    return tr


def atr(high, low, close, period: int = 14) -> np.ndarray:
    """Wilder's ATR."""
    tr = true_range(high, low, close)
    out = np.full(tr.shape, np.nan)
    if tr.size < period or period <= 0:
        return out
    out[period - 1] = np.nanmean(tr[:period])
    for i in range(period, tr.size):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def rsi(values, period: int = 14) -> np.ndarray:
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if arr.size <= period or period <= 0:
        return out
    deltas = np.diff(arr)
    gains = np.clip(deltas, 0.0, None)
    losses = np.clip(-deltas, 0.0, None)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    for i in range(period + 1, arr.size):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        out[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    return out


def bollinger(values, period: int = 20, num_std: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    middle = sma(values, period)
    std = rolling_std(values, period)
    return middle - num_std * std, middle, middle + num_std * std


def roc(values, period: int) -> np.ndarray:
    """Rate of change over `period` bars, as a fraction."""
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if arr.size <= period or period <= 0:
        return out
    prior = arr[:-period]
    with np.errstate(divide="ignore", invalid="ignore"):
        out[period:] = np.where(prior != 0, (arr[period:] - prior) / prior, np.nan)
    return out


def donchian(high, low, period: int) -> tuple[np.ndarray, np.ndarray]:
    """Rolling channel computed from bars strictly *before* the current one."""
    h, l = _as_array(high), _as_array(low)
    upper = np.full(h.shape, np.nan)
    lower = np.full(l.shape, np.nan)
    if period <= 0 or h.size <= period:
        return upper, lower
    upper[period:] = _windows(h[:-1], period).max(axis=1)
    lower[period:] = _windows(l[:-1], period).min(axis=1)
    return upper, lower


def linreg_slope(values, period: int) -> np.ndarray:
    """Annualised slope of a least-squares fit through log prices."""
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if period < 2 or arr.size < period:
        return out
    x = np.arange(period, dtype=float)
    x_centered = x - x.mean()
    denom = float((x_centered**2).sum())
    windows = _windows(arr, period)
    valid = (windows > 0).all(axis=1)
    if not valid.any():
        return out
    logs = np.full(windows.shape, np.nan)
    logs[valid] = np.log(windows[valid])
    centered = logs - logs.mean(axis=1, keepdims=True)
    slopes = (centered * x_centered).sum(axis=1) / denom * TRADING_DAYS
    out[period - 1 :] = np.where(valid, slopes, np.nan)
    return out



def returns(values) -> np.ndarray:
    arr = _as_array(values)
    out = np.full(arr.shape, np.nan)
    if arr.size < 2:
        return out
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = np.where(arr[:-1] != 0, arr[1:] / arr[:-1] - 1.0, np.nan)
    return out


def realized_volatility(values, period: int = 20) -> np.ndarray:
    """Annualised standard deviation of daily returns."""
    rets = returns(values)
    out = np.full(rets.shape, np.nan)
    if period < 2 or rets.size < period + 1:
        return out
    windows = _windows(rets[1:], period)          # drop the leading NaN return
    stds = windows.std(ddof=1, axis=1) * np.sqrt(TRADING_DAYS)
    out[period:] = np.where(np.isnan(windows).any(axis=1), np.nan, stds)
    return out



def zscore(values, period: int) -> np.ndarray:
    arr = _as_array(values)
    mean = sma(arr, period)
    std = rolling_std(arr, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where((std > 0) & ~np.isnan(std), (arr - mean) / std, np.nan)


def average_dollar_volume(close, volume, period: int = 20) -> float:
    c, v = _as_array(close), _as_array(volume)
    if c.size < period or v.size < period or period <= 0:
        return 0.0
    return float(np.nanmean(c[-period:] * v[-period:]))


def max_drawdown(equity) -> float:
    arr = _as_array(equity)
    if arr.size == 0:
        return 0.0
    peaks = np.maximum.accumulate(arr)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peaks > 0, (peaks - arr) / peaks, 0.0)
    return float(np.nanmax(dd)) if dd.size else 0.0


def correlation(a, b) -> float:
    x, y = _as_array(a), _as_array(b)
    n = min(x.size, y.size)
    if n < 3:
        return 0.0
    x, y = x[-n:], y[-n:]
    mask = ~np.isnan(x) & ~np.isnan(y)
    if mask.sum() < 3:
        return 0.0
    x, y = x[mask], y[mask]
    if x.std() == 0 or y.std() == 0:
        return 0.0
    return float(np.corrcoef(x, y)[0, 1])


def last_valid(values) -> float | None:
    arr = _as_array(values)
    valid = arr[~np.isnan(arr)]
    return float(valid[-1]) if valid.size else None


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def scale_to_unit(value: float, saturate_at: float) -> float:
    """Map a raw magnitude onto [-1, 1] with a configurable saturation point."""
    if saturate_at <= 0:
        return 0.0
    return clamp(value / saturate_at)
