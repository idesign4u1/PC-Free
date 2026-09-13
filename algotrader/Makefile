.PHONY: install test check paper api backtest live-gate docker-up docker-down lint

VENV ?= .venv
PY   := $(VENV)/bin/python

install:
	python3.12 -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r requirements-dev.txt
	$(PY) -m pip install -e .

test:
	$(PY) -m pytest

check:
	$(VENV)/bin/algotrader check

paper:
	$(VENV)/bin/algotrader paper

api:
	$(VENV)/bin/algotrader api

backtest:
	$(VENV)/bin/algotrader backtest --days 750

live-gate:
	$(VENV)/bin/algotrader live-gate

docker-up:
	docker compose up --build -d

docker-down:
	docker compose down
