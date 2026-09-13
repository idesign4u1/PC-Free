"""Deterministic identifiers used for order idempotency.

The same logical intent (account, symbol, side, quantity, strategy, decision
window) always produces the same ``client_order_id``. That id is written to the
database *before* anything is sent to the broker and is also passed to Tradier
as the order ``tag``, so a retry after a timeout can be reconciled against the
broker instead of blindly re-sent.
"""

from __future__ import annotations

import re
import uuid

# Tradier tags: alphanumerics, dash and underscore only.
_TAG_SAFE = re.compile(r"[^A-Za-z0-9_-]")
_NAMESPACE = uuid.UUID("6f0c9d4c-4f0f-5c3e-9a1a-2f1d0b7f6a11")


def deterministic_uuid(*parts: object) -> str:
    key = "|".join(str(p) for p in parts)
    return str(uuid.uuid5(_NAMESPACE, key))


def client_order_id(
    account_id: str,
    symbol: str,
    side: str,
    quantity: int,
    strategy: str,
    decision_key: str,
) -> str:
    """Stable id for one trading intent."""
    return deterministic_uuid(account_id, symbol.upper(), side, quantity, strategy, decision_key)


def order_tag(client_id: str, prefix: str = "at") -> str:
    """Broker-safe tag derived from a client order id (Tradier: <=255 chars)."""
    compact = _TAG_SAFE.sub("", client_id.replace("-", ""))[:32]
    tag = f"{prefix}-{compact}"
    return tag[:255]
