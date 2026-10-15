# SPDX-License-Identifier: GPL-3.0-or-later
"""Read WeeChat-owned buffer data on its event loop; never retain line content."""

import base64
import hmac
import json
import os
import secrets
import uuid

MAX_LINES = 500
MAX_LINE_BYTES = 512 * 1024
MAX_RESPONSE_BYTES = 768 * 1024


class NativeBuffers:
    def __init__(self, w):
        self.w = w
        self.secret = secrets.token_bytes(32)
        # Non-secret process-lifetime identity, retained across Python script or
        # interpreter reloads. A child/new WeeChat process gets a different PID
        # and therefore cannot inherit this lifetime marker accidentally.
        key = "_WEECHAT_MCP_PROCESS_INSTANCE"
        prefix = str(os.getpid()) + ":"
        marker = os.environ.get(key, "")
        try:
            if not marker.startswith(prefix):
                raise ValueError()
            uuid.UUID(marker[len(prefix) :])
        except ValueError:
            marker = prefix + str(uuid.uuid4())
            os.environ[key] = marker
        self.process_instance = marker
        # Identity bookkeeping only, not a second buffer/history store.
        self.identities = {}

    def invalidate(self, name, pointer=None):
        for key, (identity, _) in list(self.identities.items()):
            if key == name or (pointer is not None and identity[0] == pointer):
                self.identities.pop(key, None)

    def value(self, structure, pointer, field):
        """Use the actual runtime field type (line IDs changed across versions)."""
        hdata = self.w.hdata_get(structure)
        kind = self.w.hdata_get_var_type_string(hdata, field)
        if not kind:
            return None
        getter = {
            "integer": "integer",
            "long": "long",
            "longlong": "longlong",
            "time": "time",
            "char": "char",
            "string": "string",
            "shared_string": "string",
        }.get(kind)
        if getter is None:
            raise ValueError("Unsupported native field type: " + kind)
        return getattr(self.w, "hdata_" + getter)(hdata, pointer, field)

    def pointer(self, structure, pointer, field):
        return self.w.hdata_pointer(self.w.hdata_get(structure), pointer, field)

    def identity(self, name, pointer):
        native_id = self.value("buffer", pointer, "id")
        key = (pointer, native_id)
        previous = self.identities.get(name)
        if previous is None or previous[0] != key:
            previous = (key, str(uuid.uuid4()))
            self.identities[name] = previous
        return previous[1]

    def data_identity(self, name, pointer):
        native_id = self.value("buffer", pointer, "id")
        if native_id is None:
            # Old versions without stable native buffer IDs cannot establish
            # continuity across reload; consumers must fail closed on a change.
            return self.identity(name, pointer)
        return "native-buffer:" + self.process_instance + ":" + str(native_id)

    def cursor(self, name, epoch, line_id):
        data = json.dumps([name, epoch, line_id], separators=(",", ":")).encode()
        signature = hmac.digest(self.secret, data, "sha256")
        return base64.urlsafe_b64encode(signature + data).decode()

    def decode_cursor(self, token, name, epoch):
        try:
            if not isinstance(token, str) or len(token) > 4096:
                raise ValueError()
            packed = base64.b64decode(token, altchars=b"-_", validate=True)
            signature, data = packed[:32], packed[32:]
            if not hmac.compare_digest(
                signature, hmac.digest(self.secret, data, "sha256")
            ):
                raise ValueError()
            scope, generation, line_id = json.loads(data)
            if scope != name or generation != epoch or type(line_id) is not int:
                raise ValueError()
            return line_id
        except (ValueError, TypeError, UnicodeError):
            raise ValueError(
                "Invalid or expired buffer cursor; read a fresh page"
            ) from None

    def line(self, pointer):
        data = self.pointer("line", pointer, "data")
        hdata = self.w.hdata_get("line_data")
        line_id = self.value("line_data", data, "id")
        if type(line_id) is not int or line_id < 0:
            raise ValueError("Native line IDs require WeeChat 3.8 or newer")
        tags = [
            self.w.hdata_string(hdata, data, str(i) + "|tags_array")
            for i in range(self.w.hdata_integer(hdata, data, "tags_count"))
        ]
        row = {"id": line_id, "tags": tags}
        for field in ("date", "date_usec", "date_printed", "date_usec_printed"):
            value = self.value("line_data", data, field)
            if value is not None:
                row[field] = value
        for field in ("displayed", "highlight"):
            row[field] = bool(self.value("line_data", data, field))
        for field in ("prefix", "message"):
            row[field] = self.w.string_remove_color(
                self.w.hdata_string(hdata, data, field), ""
            )
        return row

    def snapshot(self, name, pointer, limit=100, cursor=None):
        if type(limit) is not int or not 1 <= limit <= MAX_LINES:
            raise ValueError("Limit must be an integer from 1 to 500")
        if self.w.buffer_get_integer(pointer, "type") != 0:
            raise ValueError("Native line pages require a formatted buffer")
        epoch = self.identity(name, pointer)
        before = None if cursor is None else self.decode_cursor(cursor, name, epoch)
        # own_lines, never mixed_lines/lines: merged windows may contain buffers
        # outside the read allowlist.
        own_lines = self.pointer("buffer", pointer, "own_lines")
        available = (
            self.w.hdata_integer(self.w.hdata_get("lines"), own_lines, "lines_count")
            if own_lines
            else 0
        )
        current = self.pointer("lines", own_lines, "last_line") if own_lines else ""
        if before is not None:
            # Only follow live native pointers. Never deserialize client pointers.
            while current:
                data = self.pointer("line", current, "data")
                if self.value("line_data", data, "id") == before:
                    break
                current = self.pointer("line", current, "prev_line")
            if not current:
                raise ValueError(
                    "Buffer cursor line is no longer retained; read a fresh page"
                )
            current = self.pointer("line", current, "prev_line")
        rows = []
        byte_count = 0
        while current and len(rows) < limit:
            row = self.line(current)
            size = len(json.dumps(row).encode())
            if size > MAX_LINE_BYTES:
                raise ValueError("Native line exceeds the 512 KiB response budget")
            if byte_count + size > MAX_LINE_BYTES:
                break
            rows.append(row)
            byte_count += size
            current = self.pointer("line", current, "prev_line")
        rows.reverse()
        next_cursor = (
            self.cursor(name, epoch, rows[0]["id"]) if current and rows else None
        )
        metadata = {
            field: self.w.buffer_get_string(pointer, field)
            for field in (
                "full_name",
                "short_name",
                "title",
                "localvar_type",
                "localvar_nick",
                "localvar_channel",
                "localvar_server",
            )
        }
        first = self.pointer("lines", own_lines, "first_line") if own_lines else ""
        oldest_id = (
            self.value("line_data", self.pointer("line", first, "data"), "id")
            if first
            else None
        )
        omitted_id = (
            self.value("line_data", self.pointer("line", current, "data"), "id")
            if current
            else None
        )
        next_id = self.value("buffer", pointer, "next_line_id")
        last_assigned = (
            next_id - 1
            if next_id is not None
            else self.value("buffer", pointer, "lines_last_id_assigned")
        )
        if next_id is None and last_assigned == 0:
            last_assigned = -1  # Native longlong allocator uses 0 for never assigned.
        result = {
            "source": "weechat_hdata",
            "buffer": metadata,
            "epoch": epoch,
            "data_epoch": self.data_identity(name, pointer),
            "lines": rows,
            "available": available,
            "returned": len(rows),
            "order": "oldest_first",
            "has_more": bool(current),
            "next_cursor": next_cursor,
            "oldest_available_id": oldest_id,
            "omitted_through_id": omitted_id,
            "last_assigned_id": last_assigned,
        }
        if len(json.dumps(result).encode()) > MAX_RESPONSE_BYTES:
            raise ValueError("Native buffer metadata exceeds the response budget")
        return result

    def event_snapshot(self, name, pointer):
        """Bounded private consumer snapshot; IDs/watermarks are per buffer."""
        snapshot = self.snapshot(name, pointer, MAX_LINES)
        nick = self.w.buffer_get_string(pointer, "localvar_nick")

        def fold(value):
            return value.lower().translate(str.maketrans("[]\\^", "{}|~"))

        rows = []
        for line in snapshot["lines"]:
            tags = set(line["tags"])
            author = next(
                (tag[5:] for tag in line["tags"] if tag.startswith("nick_")), ""
            )
            rows.append(
                {
                    **line,
                    "sequence": line["id"] + 1,
                    "nick": author,
                    "is_message": bool(tags & {"irc_privmsg", "irc_action"}),
                    "is_self": "notify_self" in tags
                    or bool(author and nick and fold(author) == fold(nick)),
                }
            )
        if rows:
            omitted = snapshot["omitted_through_id"]
            evicted = omitted + 1 if omitted is not None else 0
        else:
            # WeeChat 3.8–4.x keeps the next ID even after buffer_clear. Newer
            # versions expose the last assigned microsecond-based ID instead.
            next_id = self.value("buffer", pointer, "next_line_id")
            last_id = snapshot["last_assigned_id"]
            evicted = (
                next_id
                if next_id is not None
                else last_id + 1
                if last_id is not None
                else 0
            )
        result = {
            "epoch": snapshot["data_epoch"],
            "lines": rows,
            "own_nick": nick,
            "evicted_through": evicted,
            "native_available": snapshot["available"],
            "last_assigned_id": snapshot["last_assigned_id"],
            "native_retained_from": snapshot["oldest_available_id"],
            "returned": len(rows),
            "truncated": snapshot["has_more"],
        }
        if len(json.dumps(result).encode()) > MAX_RESPONSE_BYTES:
            raise ValueError("Native event data exceeds the response budget")
        return result
