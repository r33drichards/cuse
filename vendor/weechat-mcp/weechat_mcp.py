# SPDX-License-Identifier: GPL-3.0-or-later
"""WeeChat MCP plugin. All WeeChat calls run on its event loop, never threads."""

import json
import os
import socket
import sys
from urllib.parse import quote, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from command_manifest import build_manifest, serialize, tool_spec  # noqa: E402
from native_buffer import MAX_LINES, NativeBuffers  # noqa: E402

MAX_FRAME = 65536
SAFE_COMMANDS = {"msg", "say", "me", "names", "who", "topic"}


def full_control_enabled():
    """Full access by default; an explicit 0 retains the restricted policy."""
    value = os.environ.get("WEECHAT_MCP_FULL_CONTROL", "1")
    if value not in ("0", "1"):
        raise ValueError("WEECHAT_MCP_FULL_CONTROL must be 0 or 1")
    return value == "1"


class BridgeProtocol:
    """Private local IPC, not MCP. WeeChat operations stay on its event loop."""

    def __init__(self, api):
        self.api = api

    def handle(self, req):
        ident = req.get("id")
        try:
            operation = req["operation"]
            if operation == "tools":
                result = self.api.tools()
            elif operation == "buffers":
                result = list(self.api.buffers())
            elif operation == "call":
                result = self.api.call(req["name"], req.get("arguments", {}))
            elif operation == "buffer_data":
                result = self.api.buffer_data(self.api.resolve(req["uri"]), MAX_LINES)
            elif operation == "event_history":
                result = self.api.event_history(req["uri"])
            else:
                raise ValueError("Unknown bridge operation")
            return {"id": ident, "result": result}
        except ConnectionError as e:
            return {"id": ident, "error": str(e), "error_code": "channel_unavailable"}
        except (ValueError, KeyError, TypeError) as e:
            return {"id": ident, "error": str(e)}


class WeeChatAPI:
    def __init__(self, w, full_control=None):
        self.w = w
        self.full_control = (
            full_control_enabled() if full_control is None else full_control
        )
        self.command_source = None
        source_path = os.environ.get("WEECHAT_MCP_SOURCE_MANIFEST")
        if self.full_control and source_path:
            with open(source_path) as source_file:
                self.command_source = json.load(source_file)
        self.native = NativeBuffers(w)

    def buffers(self):
        # Restricted mode exposes only the current configured allowlist.
        # Full mode reads the same live contexts that generated commands can use.
        allowed = set(self.w.config_get_plugin("buffers").split(","))
        result = {}
        il = self.w.infolist_get("buffer", "", "")
        try:
            while self.w.infolist_next(il):
                name = self.w.infolist_string(il, "full_name")
                if self.full_control or name in allowed:
                    result[name] = self.w.infolist_pointer(il, "pointer")
        finally:
            self.w.infolist_free(il)
        return result

    def commands(self, all_commands=False):
        commands = {}
        il = self.w.infolist_get("hook", "", "command")
        try:
            while self.w.infolist_next(il):
                name = self.w.infolist_string(il, "command")
                if all_commands or name in SAFE_COMMANDS:
                    commands[name] = self.w.infolist_string(il, "description")
        finally:
            self.w.infolist_free(il)
        return commands

    def command_manifest(self):
        records = []
        il = self.w.infolist_get("hook", "", "command")
        try:
            while self.w.infolist_next(il):
                records.append(
                    {
                        "name": self.w.infolist_string(il, "command"),
                        "plugin": self.w.infolist_string(il, "plugin_name") or "core",
                        **{
                            key: self.w.infolist_string(il, key)
                            for key in (
                                "description",
                                "args",
                                "args_description",
                                "completion",
                            )
                        },
                        "keep_spaces_right": self.w.infolist_integer(
                            il, "keep_spaces_right"
                        ),
                    }
                )
        finally:
            self.w.infolist_free(il)
        return build_manifest(
            records, self.w.info_get("version", ""), self.command_source
        )

    def command_buffers(self):
        """Current native execution contexts, also readable in full-control mode."""
        result = {}
        il = self.w.infolist_get("buffer", "", "")
        try:
            while self.w.infolist_next(il):
                result[self.w.infolist_string(il, "full_name")] = (
                    self.w.infolist_pointer(il, "pointer")
                )
        finally:
            self.w.infolist_free(il)
        return result

    def call_generated(self, name, args):
        manifest = self.command_manifest()
        item = next((c for c in manifest["commands"] if c["tool_name"] == name), None)
        if item is None:
            raise ValueError("Command is no longer registered")
        value = serialize(item, args)
        contexts = self.command_buffers()
        b = args["buffer"]
        if not isinstance(b, str) or b not in contexts:
            raise ValueError("Unknown command buffer context")
        # /command explicitly selects the plugin, including shadowed commands.
        # Names originate from hooks, but still validate before composing a command.
        import re

        if not all(
            re.fullmatch(r"[^\s\"'\\\x00-\x1f\x7f]+", item[k])
            and not item[k].startswith("-")
            for k in ("plugin", "name")
        ):
            raise ValueError("Registry identity cannot be safely dispatched")
        command = "/command " + item["plugin"] + " /" + item["name"]
        rc = self.w.command(contexts[b], command + (" " + value if value else ""))
        if rc != self.w.WEECHAT_RC_OK:
            raise ValueError("WeeChat rejected command")
        return {
            "dispatched": True,
            "target_callback_status": "unavailable",
            "buffer": b,
            "command": item["name"],
            "plugin": item["plugin"],
            "registry_revision": item["revision"],
            "note": "WeeChat /command dispatcher accepted input; it does not propagate the target callback return code. Not a callback, delivery or completion acknowledgement",
        }

    def tools(self):
        tools = [
            {
                "name": "weechat_buffers",
                "description": "List exposed buffers, or read one buffer's native metadata and line data. Pages include filtered lines, oldest first, and can include lines from before plugin load. Pass next_cursor to read older lines. Command dispatch and asynchronous replies are separate; a read is not a command-completion acknowledgement.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "buffer": {
                            "type": "string",
                            "description": "An explicitly exposed full buffer name; omit to list names",
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": MAX_LINES,
                            "default": 100,
                        },
                        "cursor": {
                            "type": "string",
                            "description": "Opaque next_cursor from this buffer's previous page",
                        },
                    },
                    "additionalProperties": False,
                },
            }
        ]
        tools.append(
            {
                "name": "weechat_command_catalog",
                "description": "Discover registered slash commands and which are currently exposed by the selected execution policy",
                "inputSchema": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            }
        )
        if self.full_control:
            tools.extend(
                [
                    {
                        "name": "weechat_command_manifest",
                        "description": "Versioned complete runtime command inventory, typed/fallback coverage and metadata provenance",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": False,
                        },
                    },
                    {
                        "name": "weechat_command_contexts",
                        "description": "List all command execution buffer contexts (full control only)",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": False,
                        },
                    },
                ]
            )
            tools.extend(tool_spec(c) for c in self.command_manifest()["commands"])
            return tools
        for name, description in sorted(self.commands().items()):
            tools.append(
                {
                    "name": "weechat_" + name,
                    "description": description
                    + " (scoped to the selected exposed buffer)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "buffer": {"type": "string"},
                            "arguments": {"type": "string"},
                        },
                        "required": ["buffer"],
                        "additionalProperties": False,
                    },
                }
            )
        return tools

    def call(self, name, args):
        if not isinstance(name, str):
            raise ValueError("Tool name must be a string")
        if not isinstance(args, dict):
            raise ValueError("Arguments must be an object")
        if self.full_control:
            if name in ("weechat_command_manifest", "weechat_command_contexts"):
                if args:
                    raise ValueError("This tool takes no arguments")
                return (
                    self.command_manifest()
                    if name == "weechat_command_manifest"
                    else list(self.command_buffers())
                )
            if name.startswith("weechat_cmd_"):
                return self.call_generated(name, args)
        if name == "weechat_buffers":
            if set(args) - {"buffer", "limit", "cursor"}:
                raise ValueError("Unexpected buffer argument")
            if not args:
                return list(self.buffers())
            b = args.get("buffer")
            if not isinstance(b, str):
                raise ValueError("Buffer must be a string when reading data")
            if "cursor" in args and not isinstance(args["cursor"], str):
                raise ValueError("Cursor must be a string")
            return self.buffer_data(b, args.get("limit", 100), args.get("cursor"))
        if name == "weechat_command_catalog":
            return [
                {
                    "command": k,
                    "description": v,
                    "exposed": self.full_control or k in SAFE_COMMANDS,
                }
                for k, v in sorted(self.commands(True).items())
            ]
        if self.full_control:
            raise ValueError("Unknown generated command tool")
        command = name.removeprefix("weechat_")
        if command not in self.commands():
            raise ValueError("Command is not exposed")
        b = args.get("buffer")
        buffers = self.buffers()
        if b not in buffers:
            raise ValueError("Buffer is not exposed")
        value = args.get("arguments", "")
        if (
            not isinstance(value, str)
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or len(value.encode()) > 350
        ):
            raise ValueError("Expected a single line of at most 350 UTF-8 bytes")
        # Never permit command options or target overrides to escape the chosen buffer.
        if command in ("names", "who"):
            if value:
                raise ValueError(
                    "This command takes no arguments; target comes from buffer"
                )
            value = self.w.buffer_get_string(buffers[b], "localvar_channel")
        elif command == "msg":
            value = "* " + value
        elif command == "topic":
            channel = self.w.buffer_get_string(buffers[b], "localvar_channel")
            value = channel + (" " + value if value else "")
        elif command in ("say", "me") and value.startswith("-"):
            raise ValueError("Command options are not allowed")
        rc = self.w.command(buffers[b], "/" + command + (" " + value if value else ""))
        if rc != self.w.WEECHAT_RC_OK:
            raise ValueError("WeeChat rejected command")
        return {
            "accepted": True,
            "buffer": b,
            "note": "Local command accepted; not a delivery acknowledgement",
        }

    @staticmethod
    def uri(b):
        return "weechat://buffer/" + quote(b, safe="")

    def resolve(self, uri):
        if not isinstance(uri, str) or not uri.startswith("weechat://buffer/"):
            raise ValueError("Unknown resource")
        b = unquote(uri[len("weechat://buffer/") :])
        if b not in self.buffers():
            raise ValueError("Buffer is not exposed")
        return b

    def buffer_data(self, b, limit=100, cursor=None):
        # Always resolve the current policy and live buffers, including with a cursor.
        pointer = self.buffers().get(b)
        if not pointer:
            raise ValueError("Buffer is not exposed")
        return self.native.snapshot(b, pointer, limit, cursor)

    def event_history(self, uri):
        if not isinstance(uri, str) or not uri.startswith("weechat://buffer/"):
            raise ValueError("Unknown resource")
        b = unquote(uri[len("weechat://buffer/") :])
        if not self.full_control and b not in set(
            self.w.config_get_plugin("buffers").split(",")
        ):
            raise ValueError("Buffer is not exposed")
        pointer = self.buffers().get(b)
        if not pointer:
            raise ConnectionError("Channel temporarily unavailable")
        if (
            not b.startswith("irc.")
            or self.w.buffer_get_string(pointer, "localvar_type") != "channel"
        ):
            raise ValueError("Buffer is not an exposed IRC channel")
        try:
            return self.native.event_snapshot(b, pointer)
        except ValueError as error:
            # A native data/read limit is not a permission revocation. Events
            # must retain the grant and retry instead of deleting its outbox.
            raise ConnectionError(
                "Native channel data unavailable: " + str(error)
            ) from error


clients = {}
listener = None
api = None


def send(sock, obj):
    clients[sock]["out"] += json.dumps(obj).encode() + b"\n"
    if len(clients[sock]["out"]) > 1024 * 1024:
        drop(sock)


def drop(sock):
    clients.pop(sock, None)
    sock.close()


def tick(data, remaining):
    assert listener is not None and api is not None
    try:
        while len(clients) < 16:
            sock, _ = listener.accept()
            sock.setblocking(False)
            clients[sock] = {"in": b"", "out": b"", "protocol": BridgeProtocol(api)}
    except BlockingIOError:
        pass
    for sock, state in list(clients.items()):
        try:
            try:
                chunk = sock.recv(MAX_FRAME)
                if not chunk:
                    drop(sock)
                    continue
                state["in"] += chunk
            except BlockingIOError:
                pass
            if len(state["in"]) > MAX_FRAME:
                drop(sock)
                continue
            for _ in range(20):
                if b"\n" not in state["in"]:
                    break
                line, state["in"] = state["in"].split(b"\n", 1)
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError()
                    response = state["protocol"].handle(request)
                except (ValueError, UnicodeError):
                    response = {"id": None, "error": "Invalid bridge request"}
                if response:
                    send(sock, response)
                if sock not in clients:
                    break
            if sock not in clients:
                continue
            if state["out"]:
                try:
                    state["out"] = state["out"][sock.send(state["out"]) :]
                except BlockingIOError:
                    pass
        except OSError:
            drop(sock)
    return api.w.WEECHAT_RC_OK


def printed(data, buffer, date, tags, displayed, highlight, prefix, message):
    assert api is not None
    name = api.w.buffer_get_string(buffer, "full_name")
    if name in api.buffers():
        uri = api.uri(name)
        for sock, state in list(clients.items()):
            send(sock, {"event": "updated", "uri": uri})
    return api.w.WEECHAT_RC_OK


def buffer_closing(data, signal, pointer):
    assert api is not None
    # Closing fires while the buffer name/pointer are still valid. Invalidate
    # cursors even on pre-4.3 versions without a native unique buffer ID.
    name = api.w.buffer_get_string(pointer, "full_name")
    api.native.invalidate(name, pointer)
    return api.w.WEECHAT_RC_OK


def shutdown():
    assert api is not None
    for sock in list(clients):
        drop(sock)
    if listener:
        listener.close()
    if owns_socket and socket_path and os.path.exists(socket_path):
        os.unlink(socket_path)
    return api.w.WEECHAT_RC_OK


socket_path = None
owns_socket = False
try:
    import weechat  # ty: ignore[unresolved-import]  # Provided by WeeChat.
except ImportError:
    weechat = None
if weechat and weechat.register(
    "mcp",
    "Robert Wendt",
    "0.1.0",
    "GPL3",
    "Native MCP command tools and buffer subscriptions",
    "shutdown",
    "",
):
    if not weechat.config_is_set_plugin("buffers"):
        weechat.config_set_plugin("buffers", "irc.railway.#wchat")
    api = WeeChatAPI(weechat)
    directory = os.path.join(weechat.info_get("weechat_data_dir", ""), "mcp")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    tcp_port = os.environ.get("WEECHAT_MCP_LOOPBACK_PORT")
    if tcp_port is not None:
        # Explicit isolated development mode: never listen on a public interface.
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", int(tcp_port)))
        endpoint = "127.0.0.1:" + str(listener.getsockname()[1])
        with open(os.path.join(directory, "loopback-port"), "w") as f:
            f.write(str(listener.getsockname()[1]))
    else:
        socket_path = os.path.join(directory, "bridge.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # Fail closed if another instance owns the path; never silently replace it.
        listener.bind(socket_path)
        owns_socket = True
        os.chmod(socket_path, 0o600)
        endpoint = socket_path
    listener.listen(16)
    listener.setblocking(False)
    weechat.hook_timer(50, 0, 0, "tick", "")
    weechat.hook_print("", "", "", 1, "printed", "")
    weechat.hook_signal("buffer_closing", "buffer_closing", "")
    weechat.prnt("", "MCP local socket ready: " + endpoint)
