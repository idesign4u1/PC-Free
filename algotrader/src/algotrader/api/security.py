"""API authentication.

Read endpoints are open (the dashboard is expected to sit behind your own
network controls). Everything that *changes* state requires a token, and if no
token is configured the mutating endpoints are disabled outright rather than
left open.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request, status


async def require_api_token(
    request: Request,
    x_api_token: str | None = Header(default=None, alias="X-API-Token"),
) -> None:
    settings = request.app.state.settings
    expected = getattr(settings, "api_token", "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "mutating endpoints are disabled: set API_TOKEN in the environment "
                "to enable them"
            ),
        )
    if not x_api_token or not hmac.compare_digest(x_api_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing X-API-Token header"
        )
