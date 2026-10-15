# SPDX-License-Identifier: GPL-3.0-or-later
"""FastMCP stdio/HTTP server backed by private, event-loop-safe WeeChat IPC."""

import asyncio
import hashlib
import hmac
import json
import os
import re
import sys
from urllib.parse import quote, unquote

import mcp_types as types
from fastmcp import FastMCP
from fastmcp.resources import Resource
from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.providers import Provider
from fastmcp.tools import Tool, ToolResult
from jsonschema import validate
from mcp.server.subscriptions import (
    InMemorySubscriptionBus,
    ListenHandler,
    ResourceUpdated,
)
from pydantic import PrivateAttr


class Backend:
    """One bounded local connection per MCP host; no automatic command retries."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.pending = {}
        self.sequence = 0
        self.events = InMemorySubscriptionBus()
        self.on_disconnect = lambda: None
        self.on_buffer_updated = lambda uri: None
        self.task = asyncio.create_task(self.receive())

    async def receive(self):
        try:
            while line := await self.reader.readline():
                message = json.loads(line)
                if message.get("event") == "updated":
                    await self.events.publish(ResourceUpdated(uri=message["uri"]))
                    self.on_buffer_updated(message["uri"])
                else:
                    future = self.pending.pop(message["id"], None)
                    if future is not None and not future.done():
                        if message.get("error_code") == "channel_unavailable":
                            future.set_exception(
                                ConnectionError("Channel temporarily unavailable")
                            )
                        elif "error" in message:
                            future.set_exception(ValueError(message["error"]))
                        else:
                            future.set_result(message["result"])
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("WeeChat bridge disconnected"))
            self.pending.clear()
            self.on_disconnect()

    async def request(self, operation, **params):
        if self.task.done():
            raise ConnectionError("WeeChat bridge disconnected")
        self.sequence += 1
        ident = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            self.writer.write(
                (
                    json.dumps(dict(id=ident, operation=operation, **params)) + "\n"
                ).encode()
            )
            await self.writer.drain()
            return await asyncio.wait_for(future, 10)
        finally:
            self.pending.pop(ident, None)

    async def close(self):
        self.writer.close()
        await self.writer.wait_closed()
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class WeeChatTool(Tool):
    _backend: Backend = PrivateAttr()

    async def run(self, arguments):
        validate(arguments, self.parameters)
        value = await self._backend.request("call", name=self.name, arguments=arguments)
        return ToolResult(
            content=[types.TextContent(type="text", text=json.dumps(value))]
        )


class BufferResource(Resource):
    _backend: Backend = PrivateAttr()

    async def read(self):
        return json.dumps(await self._backend.request("buffer_data", uri=str(self.uri)))


class WeeChatProvider(Provider):
    """Discover live scoped commands/buffers on every lookup, including revocation."""

    def __init__(self, backend):
        super().__init__()
        self.backend = backend

    async def _list_tools(self):
        result = []
        for info in await self.backend.request("tools"):
            tool = WeeChatTool(
                name=info["name"],
                description=info["description"],
                parameters=info["inputSchema"],
            )
            tool._backend = self.backend
            result.append(tool)
        return result

    async def _get_tool(self, name, version=None):
        return next(
            (tool for tool in await self._list_tools() if tool.name == name), None
        )

    async def _list_resources(self):
        result = []
        for name in await self.backend.request("buffers"):
            resource = BufferResource(
                name=name,
                uri="weechat://buffer/" + quote(name, safe=""),
                mime_type="application/json",
            )
            resource._backend = self.backend
            result.append(resource)
        return result

    async def _get_resource(self, uri, version=None):
        return next(
            (
                resource
                for resource in await self._list_resources()
                if str(resource.uri) == uri
            ),
            None,
        )


class SharedSecretVerifier(TokenVerifier):
    """Single-owner bearer authentication; keep only a digest of the runtime secret."""

    def __init__(self, secret):
        super().__init__()
        self.digest = hashlib.sha256(secret.encode()).digest()

    async def verify_token(self, token):
        if hmac.compare_digest(hashlib.sha256(token.encode()).digest(), self.digest):
            return AccessToken(token=token, client_id="owner", scopes=[])
        return None


def http_settings(env):
    mode = env.get("MCP_AUTH_MODE", "bearer")
    host = env.get("MCP_HOST", "127.0.0.1")
    allowed_hosts = [
        x.strip() for x in env.get("MCP_ALLOWED_HOSTS", "").split(",") if x.strip()
    ]
    if mode == "railway-private":
        for name in ("RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"):
            if not env.get(name, "").strip():
                raise ValueError(f"railway-private mode requires {name}")
        private_domain = env.get("RAILWAY_PRIVATE_DOMAIN", "")
        if (
            not re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal",
                private_domain,
            )
            or host != private_domain
        ):
            raise ValueError(
                "railway-private requires MCP_HOST equal to RAILWAY_PRIVATE_DOMAIN"
            )
        if any(
            env.get(name)
            for name in ("RAILWAY_PUBLIC_DOMAIN", "RAILWAY_TCP_PROXY_DOMAIN")
        ):
            raise ValueError("railway-private bridge must have no public ingress")
        if not allowed_hosts or any("*" in name for name in allowed_hosts):
            raise ValueError("railway-private requires exact MCP_ALLOWED_HOSTS")
        # These runtime guards cannot prove the platform's ingress configuration.
        # The service must have no public domain or TCP proxy; see deploy/README.md.
        auth = None
    elif mode == "bearer":
        secret = env.get("MCP_AUTH_TOKEN", "")
        if len(secret) < 32 or not secret.isascii() or any(c.isspace() for c in secret):
            raise ValueError(
                "HTTP requires MCP_AUTH_TOKEN of at least 32 non-space ASCII characters"
            )
        auth = SharedSecretVerifier(secret)
    else:
        raise ValueError("MCP_AUTH_MODE must be bearer or railway-private")
    port = int(env.get("PORT", "8000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535")
    return auth, {
        "host": host,
        "port": port,
        "path": "/mcp",
        "host_origin_protection": True,
        "allowed_hosts": ["localhost:*", "127.0.0.1:*", "[::1]:*"] + allowed_hosts,
        "stateless_http": False,
    }


def create_server(backend, auth=None, event_manager=None, event_principal=None):
    server = FastMCP(
        "weechat-mcp",
        version="0.1.0",
        providers=[WeeChatProvider(backend)],
        strict_input_validation=True,
        auth=auth,
    )

    handler = ListenHandler(backend.events)
    backend.on_disconnect = handler.close

    async def listen(ctx, params):
        # Validate scope before the SDK acknowledges the stream. SDK handles
        # correlation, filtering, buffering, acknowledgement and cancellation.
        for uri in params.notifications.resource_subscriptions or ():
            await backend.request("buffer_data", uri=uri)
        # This provider emits resource updates only, not list-change events.
        honored = params.model_copy(
            update={
                "notifications": types.SubscriptionFilter(
                    resource_subscriptions=params.notifications.resource_subscriptions
                )
            }
        )
        return await handler(ctx, honored)

    # FastMCP exposes components at a high level; subscriptions/listen is an
    # SDK extension seam. Keep this single pinned private access isolated.
    server._mcp_server.add_request_handler(
        "subscriptions/listen", types.SubscriptionsListenRequestParams, listen
    )
    if event_manager is not None:
        from event_protocol import install_event_protocol

        if event_principal is None:
            raise ValueError("Events require an authenticated principal provider")
        install_event_protocol(server, event_manager, event_principal)
        backend.on_buffer_updated = lambda uri: event_manager.notify(
            unquote(uri.removeprefix("weechat://buffer/"))
        )
    return server


def event_settings(env, auth, transport):
    """Disabled unless explicitly configured. Configuration creates no subscription."""
    path = env.get("MCP_EVENTS_DB")
    if not path:
        return None
    if transport != "http":
        raise ValueError("MCP Events requires the authenticated HTTP endpoint")
    if isinstance(auth, SharedSecretVerifier):
        from fastmcp.server.dependencies import get_access_token

        owner = "bearer:" + auth.digest.hex()

        def principal():
            token = get_access_token()
            if token is None or not hmac.compare_digest(
                hashlib.sha256(token.token.encode()).digest(), auth.digest
            ):
                raise ValueError("Authentication required")
            return owner
    else:
        owner = env.get("MCP_EVENTS_OWNER", "")
        if not re.fullmatch(r"[A-Za-z0-9._:@-]{1,128}", owner):
            raise ValueError(
                "Railway-private Events requires a stable single-owner MCP_EVENTS_OWNER"
            )
        # Only reachable behind the guarded, single-owner private authentication proxy.
        owner = "railway-private:" + owner

        def principal():
            return owner

    return path, owner, principal


async def run_with_event_workers(server_run, event_manager):
    if event_manager is None:
        return await server_run
    task = asyncio.create_task(server_run)
    try:
        done, _ = await asyncio.wait(
            [task, event_manager.task, event_manager.intake_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        if task in done:
            return await task
        # Do not expose a background exception's text or locals; fail closed so
        # a supervisor can restart instead of serving an inert event endpoint.
        raise RuntimeError("MCP Events worker stopped; restart required")
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def main():
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    if transport not in ("stdio", "http"):
        raise ValueError("MCP_TRANSPORT must be stdio or http")
    auth, settings = http_settings(os.environ) if transport == "http" else (None, {})
    events = event_settings(os.environ, auth, transport)
    tcp = len(sys.argv) == 3 and sys.argv[1] == "--loopback-port"
    if not tcp and len(sys.argv) != 2:
        raise SystemExit(
            "Usage: bridge.py /path/to/bridge.sock OR --loopback-port PORT"
        )
    if tcp:
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", int(sys.argv[2]), limit=1024 * 1024
        )
    else:
        reader, writer = await asyncio.open_unix_connection(
            sys.argv[1], limit=1024 * 1024
        )
    backend = Backend(reader, writer)
    event_manager = None
    try:
        principal = None
        if events is not None:
            from mcp_events import EventManager

            path, owner, principal = events
            event_manager = EventManager(path, backend, lambda value: value == owner)
        server = create_server(
            backend, auth=auth, event_manager=event_manager, event_principal=principal
        )
        if event_manager is not None:
            event_manager.start()
        if transport == "http":
            await run_with_event_workers(
                server.run_http_async(
                    transport="http", show_banner=False, log_level="ERROR", **settings
                ),
                event_manager,
            )
        else:
            await server.run_stdio_async(show_banner=False, log_level="ERROR")
    finally:
        if event_manager is not None:
            await event_manager.close()
        await backend.close()


if __name__ == "__main__":
    asyncio.run(main())
