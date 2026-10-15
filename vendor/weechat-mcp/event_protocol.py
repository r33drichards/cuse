# SPDX-License-Identifier: GPL-3.0-or-later
"""MCP Events wire adapter for the pinned FastMCP 4.1 / MCP 2.3 SDKs.

Event methods use the same server and authentication context as ordinary tools.
These SDK versions support custom methods but do not yet model the draft events
capability. A narrow response middleware restores that one capability after the
SDK's version-specific discovery serializer, without changing its other fields.
"""

from collections.abc import Callable
from dataclasses import replace
from typing import Any, Literal

from mcp import types
from mcp.shared.exceptions import MCPError
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
    model_serializer,
)

from mcp_events import EventError


class _EventParams(types.RequestParams):
    model_config = ConfigDict(strict=True, extra="forbid", hide_input_in_errors=True)

    @classmethod
    def model_validate(cls, obj, *args, **kwargs):
        # Pydantic retains raw input in ValidationError.errors(), including
        # sibling fields when a required field is absent. Never allow that
        # exception to reach SDK logging, telemetry, or error serialization.
        try:
            return super().model_validate(obj, *args, **kwargs)
        except ValidationError:
            raise MCPError(-32602, "Invalid event request parameters") from None


class WebhookDelivery(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", hide_input_in_errors=True)

    mode: Literal["webhook"]
    url: str


class SubscribeDelivery(WebhookDelivery):
    secret: SecretStr


class ListEventsParams(_EventParams):
    cursor: str | None = None


class SubscribeEventParams(_EventParams):
    name: str
    arguments: dict[str, Any]
    delivery: SubscribeDelivery
    cursor: str | None = None
    ttl_ms: int | None = Field(default=None, alias="ttlMs", gt=0)


class UnsubscribeEventParams(_EventParams):
    name: str
    arguments: dict[str, Any]
    delivery: WebhookDelivery


class EventResult(types.Result):
    """Preserve extension payloads and the protocol's explicit null values."""

    model_config = ConfigDict(extra="allow")

    @model_serializer(mode="wrap")
    def _serialize_explicit_nulls(self, handler):
        result = handler(self)
        # The SDK always dumps with exclude_none=True. For event results,
        # cursor:null and refreshBefore:null carry protocol meaning.
        for name, value in (self.model_extra or {}).items():
            if value is None:
                result[name] = None
        return result


class _EventProtocolBoundary:
    """Keep credentials out of FastMCP hooks and retain events discovery."""

    async def __call__(self, ctx, call_next):
        params_type = {
            "events/list": ListEventsParams,
            "events/subscribe": SubscribeEventParams,
            "events/unsubscribe": UnsubscribeEventParams,
        }.get(ctx.method)
        if params_type is not None and ctx.request_id is not None:
            # Validate before FastMCP's generic middleware sees raw params.
            # Keep the secret as SecretStr until the manager call. The copy
            # avoids mutating the request or a caller-owned params dictionary.
            params = params_type.model_validate(
                {} if ctx.params is None else ctx.params, by_name=False
            )
            ctx = replace(
                ctx,
                params=params.model_dump(by_alias=True, exclude_unset=True),
            )
        result = await call_next(ctx)
        if ctx.method == "server/discover" and ctx.request_id is not None:
            if isinstance(result, BaseModel):
                result = result.model_dump(
                    by_alias=True, mode="json", exclude_none=True
                )
            result = dict(result)
            result["capabilities"] = {
                **result.get("capabilities", {}),
                "events": {},
            }
        return result


def install_event_protocol(server, manager, principal_provider: Callable[[], str]):
    """Register owner-scoped event methods on an existing authenticated server.

    ``manager`` supplies async ``list_events(owner, cursor)``,
    ``subscribe(owner, params)`` and ``unsubscribe(owner, params)`` methods.
    EventError messages/reasons must be safe public protocol text; unexpected
    errors are intentionally replaced with a generic response. The synchronous
    principal provider must derive the owner from trusted authentication state,
    never request parameters or a client-chosen header.
    """

    def owner():
        try:
            value = principal_provider()
            if not isinstance(value, str) or not value:
                raise ValueError("Missing authenticated owner")
            return value
        except Exception:
            raise MCPError(-32000, "Authentication required") from None

    async def invoke(operation, principal, params):
        try:
            if operation == "list":
                payload = await manager.list_events(principal, cursor=params.cursor)
            else:
                arguments = params.model_dump(
                    by_alias=True, exclude_unset=True, exclude={"meta"}
                )
                if operation == "subscribe":
                    arguments["delivery"]["secret"] = (
                        params.delivery.secret.get_secret_value()
                    )
                    payload = await manager.subscribe(principal, arguments)
                else:
                    payload = await manager.unsubscribe(principal, arguments)
            return EventResult.model_validate(payload)
        except EventError as error:
            data = {"reason": error.reason} if error.reason is not None else None
            raise MCPError(error.code, error.message, data) from None
        except Exception:
            # Managers may have raw credentials in locals or exception text.
            # Do not log the exception or let SDK error handlers log it.
            raise MCPError(-32603, "Event request failed") from None

    async def list_events(ctx, params):
        return await invoke("list", owner(), params)

    async def subscribe(ctx, params):
        return await invoke("subscribe", owner(), params)

    async def unsubscribe(ctx, params):
        return await invoke("unsubscribe", owner(), params)

    lowlevel = server._mcp_server
    lowlevel.add_request_handler("events/list", ListEventsParams, list_events)
    lowlevel.add_request_handler("events/subscribe", SubscribeEventParams, subscribe)
    lowlevel.add_request_handler(
        "events/unsubscribe", UnsubscribeEventParams, unsubscribe
    )
    # Outermost: FastMCP also reparses discover responses into its own closed
    # capability model. Inserting before that boundary preserves the extra
    # capability without monkeypatching global SDK schemas or any core method.
    if not any(
        isinstance(item, _EventProtocolBoundary) for item in lowlevel.middleware
    ):
        lowlevel.middleware.insert(0, _EventProtocolBoundary())
