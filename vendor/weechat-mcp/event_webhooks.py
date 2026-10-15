# SPDX-License-Identifier: GPL-3.0-or-later
"""Standard Webhooks signing and a bounded, SSRF-safe HTTPS transport.

Callback URLs and response bodies are untrusted. This module never logs them or
includes them in exceptions. Every request resolves the host afresh, validates
*all* returned addresses, then connects a numeric sockaddr without another DNS
lookup. TLS still verifies the callback's original hostname. No proxy discovery,
redirect handling, cookies, connection pool, or response decompression is used.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import ipaddress
import re
import socket
import ssl
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

MAX_URL_BYTES = 4096
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_HEADER_BYTES = 32 * 1024
MAX_HEADER_LINE = 8192
MAX_HEADERS = 100
_TOKEN = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.I)
_STATUS = re.compile(rb"HTTP/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?\r\n")
# Be conservative across supported Python versions' varying special-use lists.
_BLOCKED_V4 = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
_BLOCKED_V6 = tuple(
    ipaddress.ip_network(network)
    for network in ("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")
)
_GLOBAL_V6 = ipaddress.ip_network("2000::/3")


class WebhookError(Exception):
    """A safe, categorized error. Never attach URLs, secrets, or peer responses."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class _Target:
    hostname: str
    port: int
    host_header: str
    request_target: str


def _public_address(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise WebhookError("blocked_address") from None
    if not address.is_global or address.is_multicast or address.is_unspecified:
        raise WebhookError("blocked_address")
    if isinstance(address, ipaddress.IPv4Address):
        if any(address in network for network in _BLOCKED_V4):
            raise WebhookError("blocked_address")
    elif (
        "%" in value
        or address not in _GLOBAL_V6
        or any(address in network for network in _BLOCKED_V6)
        or address.ipv4_mapped is not None
    ):
        # This also excludes local/NAT64 prefixes, mapped IPv4, 6to4 and Teredo.
        raise WebhookError("blocked_address")
    return address


def _target(url: str) -> _Target:
    if (
        not isinstance(url, str)
        or not url
        or len(url) > MAX_URL_BYTES
        or not url.isascii()
        or any(ord(char) <= 32 or ord(char) == 127 for char in url)
        or "\\" in url
        or "#" in url
    ):
        raise WebhookError("invalid_url")
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        port = parts.port
        if (
            parts.scheme != "https"
            or not parts.netloc
            or hostname is None
            or parts.username is not None
            or parts.password is not None
            or "%" in hostname
            or not 0 < (port if port is not None else 443) < 65536
        ):
            raise ValueError
        # Empty explicit ports are ambiguous and should not be normalized away.
        if parts.netloc.endswith(":"):
            raise ValueError
        if ":" in hostname:
            address = _public_address(hostname)
            if not isinstance(address, ipaddress.IPv6Address):
                raise ValueError
            host_header = f"[{hostname}]"
        else:
            try:
                ipaddress.ip_address(hostname)
            except ValueError:
                # ASCII punycode DNS names are supported, raw Unicode is not.
                dns_name = hostname.rstrip(".")
                if (
                    not dns_name
                    or len(dns_name) > 253
                    or hostname.endswith("..")
                    or any(
                        not _HOST_LABEL.fullmatch(label)
                        for label in dns_name.split(".")
                    )
                ):
                    raise ValueError
            else:
                _public_address(hostname)
            host_header = hostname
        if port is not None and port != 443:
            host_header += f":{port}"
        path = parts.path or "/"
        if not path.startswith("/"):
            raise ValueError
        request_target = path + (f"?{parts.query}" if parts.query else "")
        return _Target(hostname, port or 443, host_header, request_target)
    except WebhookError:
        raise
    except (ValueError, UnicodeError):
        raise WebhookError("invalid_url") from None


def validate_url(url: str) -> str:
    """Validate URL syntax and literal addresses; DNS is checked on each POST."""
    _target(url)
    return url


def validate_secret(secret: str) -> bytes:
    """Decode a canonical Standard Webhooks whsec_ key of 24 through 64 bytes."""
    if (
        not isinstance(secret, str)
        or not secret.startswith("whsec_")
        or not 38 <= len(secret) <= 94
    ):
        raise WebhookError("invalid_secret")
    try:
        encoded = secret[6:].encode("ascii")
        key = base64.b64decode(encoded, validate=True)
    except (ValueError, UnicodeError, binascii.Error):
        raise WebhookError("invalid_secret") from None
    if not 24 <= len(key) <= 64 or base64.b64encode(key) != encoded:
        raise WebhookError("invalid_secret")
    return key


def _header_value(value: str) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_HEADER_LINE
        and value.isascii()
        and all(32 <= ord(char) <= 126 for char in value)
    )


def signed_headers(
    event_id: str,
    body: bytes,
    secrets: str | Sequence[str],
    subscription_id: str,
    timestamp: int | None = None,
) -> dict[str, str]:
    """Sign the exact bytes sent, with space-separated v1 signatures for rotation."""
    if not isinstance(body, bytes):
        raise WebhookError("invalid_payload")
    if len(body) > MAX_PAYLOAD_BYTES:
        raise WebhookError("payload_too_large")
    if (
        not _header_value(event_id)
        or not _header_value(subscription_id)
        or any(char.isspace() for char in event_id + subscription_id)
    ):
        raise WebhookError("invalid_headers")
    if timestamp is None:
        timestamp = int(time.time())
    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, int)
        or not 0 <= timestamp < 2**63
    ):
        raise WebhookError("invalid_headers")
    if isinstance(secrets, str):
        keys = [secrets]
    elif isinstance(secrets, Sequence) and 1 <= len(secrets) <= 8:
        keys = list(secrets)
    else:
        raise WebhookError("invalid_secret")
    payload = f"{event_id}.{timestamp}.".encode("ascii") + body
    signatures = [
        "v1,"
        + base64.b64encode(hmac.digest(validate_secret(key), payload, "sha256")).decode(
            "ascii"
        )
        for key in keys
    ]
    return {
        "Content-Type": "application/json",
        "webhook-id": event_id,
        "webhook-timestamp": str(timestamp),
        "webhook-signature": " ".join(signatures),
        "X-MCP-Subscription-Id": subscription_id,
    }


class SecureWebhookSender:
    """An async POST callback with one total deadline and no ambient proxy use."""

    def __init__(self, *, timeout: float = 10.0, max_response_bytes: int = 64 * 1024):
        if (
            not isinstance(timeout, (float, int))
            or isinstance(timeout, bool)
            or not 0 < timeout <= 30
            or not isinstance(max_response_bytes, int)
            or isinstance(max_response_bytes, bool)
            or not 0 < max_response_bytes <= 256 * 1024
        ):
            raise ValueError("invalid transport limits")
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._tls = ssl.create_default_context()
        self._tls.minimum_version = ssl.TLSVersion.TLSv1_2
        self._tls.set_alpn_protocols(["http/1.1"])

    async def post(
        self, url: str, body: bytes, headers: Mapping[str, str]
    ) -> tuple[int, bytes]:
        """Return status/body; transport failures expose only safe reason strings."""
        target = _target(url)
        if not isinstance(body, bytes):
            raise WebhookError("invalid_payload")
        if len(body) > MAX_PAYLOAD_BYTES:
            raise WebhookError("payload_too_large")
        request = self._request(target, body, headers)
        try:
            return await asyncio.wait_for(self._post(target, request), self.timeout)
        except WebhookError:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            raise WebhookError("timeout") from None
        except ssl.SSLError:
            raise WebhookError("tls_error") from None
        except socket.gaierror:
            raise WebhookError("dns_error") from None
        except OSError:
            raise WebhookError("connection_failed") from None
        except (ValueError, EOFError, asyncio.IncompleteReadError):
            raise WebhookError("invalid_response") from None

    @staticmethod
    def _request(target: _Target, body: bytes, headers: Mapping[str, str]) -> bytes:
        lines = [
            f"POST {target.request_target} HTTP/1.1",
            f"Host: {target.host_header}",
            f"Content-Length: {len(body)}",
            "Connection: close",
        ]
        seen = set()
        for name, value in headers.items():
            if (
                not isinstance(name, str)
                or not name.isascii()
                or not _TOKEN.fullmatch(name.encode("ascii"))
                or not _header_value(value)
            ):
                raise WebhookError("invalid_headers")
            lower = name.lower()
            if lower in seen or lower in {
                "host",
                "content-length",
                "transfer-encoding",
                "connection",
                "proxy-authorization",
                "proxy-connection",
                "upgrade",
                "expect",
            }:
                raise WebhookError("invalid_headers")
            seen.add(lower)
            lines.append(f"{name}: {value}")
        encoded = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")
        if len(encoded) > MAX_HEADER_BYTES or len(seen) > MAX_HEADERS:
            raise WebhookError("invalid_headers")
        return encoded + body

    async def _connect(self, target: _Target):
        loop = asyncio.get_running_loop()
        answers = await loop.getaddrinfo(
            target.hostname,
            target.port,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
        if not answers:
            raise WebhookError("dns_error")
        addresses = []
        # Validate the complete answer set *before* attempting the first connect.
        for family, socktype, proto, _canonname, sockaddr in answers:
            if (
                family not in (socket.AF_INET, socket.AF_INET6)
                or socktype != socket.SOCK_STREAM
                or proto not in (0, socket.IPPROTO_TCP)
                or len(sockaddr) != (4 if family == socket.AF_INET6 else 2)
                or not isinstance(sockaddr[0], str)
                or sockaddr[1] != target.port
                or (family == socket.AF_INET6 and any(sockaddr[2:]))
            ):
                raise WebhookError("blocked_address")
            address = _public_address(sockaddr[0])
            if address.version != (4 if family == socket.AF_INET else 6):
                raise WebhookError("blocked_address")
            # Store normalized numeric addresses, never the original DNS name.
            pinned = (str(address), target.port)
            if family == socket.AF_INET6:
                pinned = (*pinned, 0, 0)
            record = (family, pinned)
            if record not in addresses:
                addresses.append(record)
        for family, sockaddr in addresses:
            sock = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            sock.setblocking(False)
            try:
                await loop.sock_connect(sock, sockaddr)
                return await asyncio.open_connection(
                    sock=sock,
                    ssl=self._tls,
                    server_hostname=target.hostname,
                    ssl_handshake_timeout=self.timeout,
                    limit=MAX_HEADER_LINE,
                )
            except BaseException as error:
                sock.close()
                # Retry another already validated address only for connect errors.
                # Certificate failures and cancellation never fall through.
                if isinstance(error, OSError) and not isinstance(error, ssl.SSLError):
                    continue
                raise
        raise WebhookError("connection_failed")

    async def _post(self, target: _Target, request: bytes) -> tuple[int, bytes]:
        reader, writer = await self._connect(target)
        try:
            writer.write(request)
            await writer.drain()
            return await self._response(reader)
        finally:
            writer.close()
            # A hostile TLS peer must not hold resources with a stalled close-notify.
            writer.transport.abort()

    @staticmethod
    async def _line(reader: asyncio.StreamReader) -> bytes:
        line = await reader.readline()
        if not line.endswith(b"\r\n") or len(line) > MAX_HEADER_LINE:
            raise WebhookError("invalid_response")
        return line

    async def _headers(self, reader: asyncio.StreamReader) -> dict[bytes, list[bytes]]:
        result: dict[bytes, list[bytes]] = {}
        size = 0
        count = 0
        while True:
            line = await self._line(reader)
            size += len(line)
            if size > MAX_HEADER_BYTES:
                raise WebhookError("response_too_large")
            if line == b"\r\n":
                return result
            count += 1
            name, separator, value = line[:-2].partition(b":")
            if (
                count > MAX_HEADERS
                or not separator
                or not _TOKEN.fullmatch(name)
                or any(byte < 32 and byte != 9 or byte == 127 for byte in value)
            ):
                raise WebhookError("invalid_response")
            result.setdefault(name.lower(), []).append(value.strip(b" \t"))

    async def _response(self, reader: asyncio.StreamReader) -> tuple[int, bytes]:
        for _ in range(6):
            match = _STATUS.fullmatch(await self._line(reader))
            if not match:
                raise WebhookError("invalid_response")
            status = int(match[1])
            headers = await self._headers(reader)
            if status >= 200:
                break
            if status == 101:
                raise WebhookError("invalid_response")
        else:
            raise WebhookError("invalid_response")
        if 300 <= status < 400:
            raise WebhookError("redirect_blocked")
        lengths = headers.get(b"content-length", [])
        encodings = [value.lower() for value in headers.get(b"transfer-encoding", [])]
        if len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings):
            raise WebhookError("invalid_response")
        if encodings and encodings != [b"chunked"]:
            raise WebhookError("invalid_response")
        if lengths:
            if not re.fullmatch(rb"[0-9]+", lengths[0]):
                raise WebhookError("invalid_response")
            if len(lengths[0]) > 10 or int(lengths[0]) > self.max_response_bytes:
                raise WebhookError("response_too_large")
            length = int(lengths[0])
        else:
            length = None
        if status in (204, 205):
            if encodings or length:
                raise WebhookError("invalid_response")
            return status, b""
        if length is not None:
            return status, await reader.readexactly(length)
        if encodings:
            return status, await self._chunked(reader)
        body = bytearray()
        while True:
            part = await reader.read(min(8192, self.max_response_bytes + 1 - len(body)))
            if not part:
                return status, bytes(body)
            body.extend(part)
            if len(body) > self.max_response_bytes:
                raise WebhookError("response_too_large")

    async def _chunked(self, reader: asyncio.StreamReader) -> bytes:
        body = bytearray()
        framing_bytes = 0
        while True:
            line = await self._line(reader)
            framing_bytes += len(line)
            if framing_bytes > MAX_HEADER_BYTES:
                raise WebhookError("response_too_large")
            size = line[:-2].split(b";", 1)[0]
            if not re.fullmatch(rb"[0-9A-Fa-f]{1,16}", size):
                raise WebhookError("invalid_response")
            count = int(size, 16)
            if count > self.max_response_bytes - len(body):
                raise WebhookError("response_too_large")
            if count == 0:
                trailers = await self._headers(reader)
                if b"content-length" in trailers or b"transfer-encoding" in trailers:
                    raise WebhookError("invalid_response")
                return bytes(body)
            body.extend(await reader.readexactly(count))
            if await reader.readexactly(2) != b"\r\n":
                raise WebhookError("invalid_response")
