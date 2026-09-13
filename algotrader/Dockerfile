# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY pyproject.toml README.md ./
COPY src ./src
COPY config ./config
RUN pip install --no-deps -e .

# Run as an unprivileged user: this process holds brokerage credentials.
RUN useradd --create-home --uid 10001 trader && chown -R trader:trader /app
USER trader

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Default: dashboard/API only - it never places orders on its own.
# docker-compose overrides this with `algotrader paper` for the trading service.
CMD ["algotrader", "api", "--host", "0.0.0.0", "--port", "8000"]
