<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# WeeChat MCP

A FastMCP server for scoped WeeChat commands and live buffer resources. WeeChat
owns IRC; the MCP server runs in a separate Python process. All WeeChat API calls
stay on WeeChat's event loop.

## Architecture

- `weechat_mcp.py`: dependency-free WeeChat plugin. Exposes allowlisted buffers,
  safe command adapters and native buffer data over private local IPC.
- `native_buffer.py`: read-only official hdata traversal. WeeChat owns the lines;
  the adapter holds only cursor/lifecycle metadata, never a second content cache.
- `bridge.py`: FastMCP 4.1.0 server. Dynamic providers discover available commands
  and buffers; the MCP SDK handles transport, validation, lifecycle and dispatch.
- `client.py`: small host facade over the official MCP SDK client, explicitly using
  protocol **2026-07-28** and acknowledged `subscriptions/listen` streams.
- `runner.py`: deterministic mention-trigger experiment with a durable SQLite
  inbox, deduplication, busy queue and turn limits. It does not invoke a model.

FastMCP exposes tools/resources at a high level. Its underlying MCP SDK 2.3.0
provides `ListenHandler` and `InMemorySubscriptionBus`, which handle stream
acknowledgment, request correlation, filtering, bounded buffering and cancellation.
One isolated access to `server._mcp_server.add_request_handler` registers that SDK
handler; FastMCP currently has no high-level subscription registration API.
Dependencies are pinned, and subscription tests must pass before upgrades.
There is no project-owned MCP dispatcher, handshake or compatibility fallback.

## Run

Requirements: WeeChat with its Python plugin, Python 3.10+ for the external server,
Unix sockets, and permitted DNS/TCP access to your IRC server. Use an isolated
WeeChat profile rather than your normal private-message history.

Install the external server dependencies:

```sh
uv sync --locked
```

WeeChat's embedded Python needs only the standard library. Load the plugin:

```
/python load /path/to/weechat-mcp/weechat_mcp.py
/set plugins.var.python.mcp.buffers irc.railway.#wchat
```

Configure your server locally in WeeChat, using alias `railway` (or update the
buffer allowlist), connect and join `#wchat`. Verify TLS before using credentials.
The plugin neither requires nor exports credentials.

Configure your MCP host:

```json
{"mcpServers":{"weechat":{"command":"/path/to/weechat-mcp/.venv/bin/python","args":["/path/to/weechat-mcp/bridge.py","/path/to/weechat-data/mcp/bridge.sock"]}}}
```

The plugin socket is private IPC, not an MCP endpoint. Hosts launch `bridge.py`.
The directory is mode 0700 and socket 0600. Existing sockets are never replaced;
after a crash, verify no process owns a stale socket before removing it.
Never expose this endpoint to untrusted users.

## Docker: WeeChat + MCP in one image

The image contains actual headless WeeChat, its IRC/Python plugins, this project's
WeeChat plugin, and the pinned FastMCP bridge. It runs as UID 10001. Each launch
creates an isolated, private temporary profile and starts both processes. The
supervisor shuts down both on SIGTERM, bridge exit, or WeeChat failure. Logs go to
stderr; stdout is reserved for MCP. Profile/history are ephemeral. No model runs
inside the image.

```sh
docker build -t weechat-mcp:local .
docker run --rm -i \
  -e IRC_HOST=irc.example.org -e IRC_NICK=myagent \
  -e IRC_CHANNELS='#wchat' weechat-mcp:local
```

Use `docker run --rm -i` as your MCP host's command/arguments, with the environment
above. Do not add `-t`: terminal allocation corrupts stdio framing. No port mapping
is needed for stdio. Closing host stdin stops the bridge and WeeChat.

Runtime IRC settings:

- `IRC_HOST`: required DNS hostname or IPv4 address (not a URL)
- `IRC_PORT`: default `6697`
- `IRC_TLS`: `true` by default; certificate verification stays enabled
- `IRC_NICK`: default `weechat-mcp`
- `IRC_CHANNELS`: comma-separated channel names, default `#wchat`

Persistence:

- `WEECHAT_HOME`: optional absolute path of a persistent WeeChat home, such as a
  Railway volume mounted at `/data/weechat`. Without it WeeChat runs from a
  temporary directory that is discarded on exit and the settings above are
  reapplied on every start. With it, the `IRC_*` settings and the exposed-buffer
  allowlist are applied only on the **first** boot (no `weechat.conf` yet); after
  that the saved configuration is authoritative, so runtime edits made through
  the exposed `/set` command (for example widening
  `plugins.var.python.mcp.buffers`, or changing autojoin) survive restarts.
  WeeChat saves its configuration on clean shutdown (`SIGTERM`), or sooner with
  `/save`. To re-apply changed environment settings, edit the saved config or
  remove `weechat.conf` from the volume. The image starts as root only to make
  the volume private to UID/GID 10001, then drops privileges permanently before
  WeeChat or the bridge run; the home must not be world/group-writable.

The fixed server alias is `docker`; exposed buffers are `irc.docker.#wchat`, etc.
Only configured channels are exposed, never all IRC buffers or direct messages.
For a local plaintext IRC test set both `IRC_TLS=false` and `IRC_PORT=6667` (or
its actual port). Container localhost means the container itself: use an IRC
service name on a private Docker network, or the appropriate host gateway.
This minimal bootstrap currently supports unauthenticated IRC servers; SASL and
server-password configuration are not implemented. Never put credentials in an
image, Docker build arguments, hostname, or channel names.

### Streamable HTTP

Set `MCP_TRANSPORT=http` for FastMCP's native Streamable HTTP endpoint at `/mcp`.
Stdio remains the default. Protocol **2026-07-28** and stateful subscription streams
are unchanged; this is not legacy SSE transport. `PORT` defaults to `8000`, and
`MCP_HOST` defaults to `127.0.0.1`. For Docker port forwarding set `MCP_HOST=0.0.0.0`.
Default `MCP_AUTH_MODE=bearer` startup fails closed without `MCP_AUTH_TOKEN` (at least 32 non-space ASCII
characters). Supply a high-entropy runtime secret through your secret manager;
clients send `Authorization: Bearer <token>`. This is single-owner backend
protection, not an OAuth login service. Everyone with this secret shares one IRC
identity and the same allowlisted channel history.

With `MCP_AUTH_TOKEN` already injected into the shell environment:

```sh
docker run --rm --init \
  -p 127.0.0.1:8000:8000 \
  -e MCP_TRANSPORT=http -e MCP_HOST=0.0.0.0 -e MCP_AUTH_TOKEN \
  -e IRC_HOST=irc.example.org -e IRC_NICK=myagent \
  -e IRC_CHANNELS='#wchat' weechat-mcp:local
```

Connect to `http://127.0.0.1:8000/mcp` with the authorization header. HTTP has
explicit Host/Origin protection. For a trusted reverse proxy set
`MCP_ALLOWED_HOSTS` to the exact comma-separated hostnames it forwards (including
ports where applicable); localhost hosts are allowed by default. Do not use `*`.
No cross-origin browser access is enabled. Use TLS at the public proxy, keep the
backend private, and never publish the local plaintext HTTP endpoint directly.
`PORT` supports platforms such as Railway; adding this setting does not deploy or
provision anything. Use one replica per IRC identity: state and subscriptions are
process-local, and replicas with the same nickname will collide.

For the Pomerium → Dex → GitHub login pattern, see [deployment templates](deploy/README.md).
The proxy injects the backend secret by default; external MCP clients do not
receive it. The deployment guide also documents explicit `railway-private` mode,
which omits this extra bearer only on a guarded private Railway bridge with no
public ingress. Pomerium's owner-only GitHub/Dex authentication remains required.

### Container verification

Unit checks cover runtime input validation, authentication and cleanup. The
Docker-capable integration uses a fresh image, an ephemeral localhost miniircd,
and a separate IRC observer to prove authenticated HTTP MCP send/receive and
subscription delivery. Linux host networking is used only for that isolated test.
See the CI Docker job and `docker_test.py`; `--host` mode explicitly tests the
entrypoint on the host and does not validate an image build or container runtime.
In a sandbox that prohibits Unix sockets, host tests explicitly use
`WEECHAT_MCP_LOOPBACK_PORT=0`: private namespace loopback IPC, not public MCP.
Never enable this test override in an untrusted/shared network namespace.

```sh
# Builds and runs the real image (Linux Docker required):
uv run python docker_test.py --miniircd /path/to/miniircd
# Host fallback only; explicitly does not test Docker or Unix socket IPC:
uv run python docker_test.py --host --loopback-ipc \
  --weechat-root /tmp/weechat-runtime/root --miniircd /tmp/weechat-miniircd/miniircd
```

## Tools and resources

`weechat_buffers` lists exposed buffers. `weechat_command_catalog` discovers
registered slash commands and marks which have execution adapters. The scoped
adapters are `msg`, `say`, `me`, `names`, `who` and `topic`, when registered by the
installed WeeChat version (`say` is absent in WeeChat 4.6.3).

`weechat_buffers` with no arguments lists the current read-allowlisted buffers.
Pass `buffer` to read that buffer's native metadata and printed line data, plus
optional `limit` (default 100; 1–500) and opaque `cursor`. This extends the existing
buffer interface; the old `weechat_read_recent_messages` tool has been removed,
with no compatibility alias or print-captured history ring.

```json
{"name":"weechat_buffers","arguments":{"buffer":"irc.railway.#wchat","limit":100}}
```

The data comes directly from WeeChat's official `hdata_get`, `hdata_pointer`,
`hdata_*` typed getters, and `buffer_get_*` bindings. It can include lines printed
before the MCP plugin was loaded. Only the selected buffer's `own_lines` are
traversed; merged windows do not broaden access to other buffers. Every request,
including pagination, checks the current read allowlist. Full-control command
contexts do not grant additional buffer-read access. No arbitrary hdata pointers,
paths, configuration or credentials are exposed.

Native buffer data semantics:

- Each page selects the newest remaining lines and returns them in native
  insertion order, oldest first. Backdated IRC replay timestamps do not reorder
  them. `next_cursor` reads the preceding page; new arrivals do not shift it.
- `lines` includes status, notices, own output and filter-hidden lines. There is
  no additional message filter. `displayed` and `highlight` are native flags;
  `tags` preserves the native tags. `id`, `date`, optional timestamp microseconds
  and print timestamps come from native line data. `prefix` and `message` have
  WeeChat color codes removed. A printed line is not necessarily an IRC message.
- `available` is the current native line count, not a historical total.
  `returned`, `has_more`, and `next_cursor` describe the page. `epoch` identifies
  this adapter instance/buffer lifetime; it is not a durable archive identity.
  `data_epoch` separately identifies a native buffer lifetime using a non-secret
  process nonce and native buffer ID where supported, so consumers do not replay
  retained lines after plugin reload. Older versions without stable native IDs
  cannot prove reload continuity and must fail closed on a lifetime change.
  `oldest_available_id`, `last_assigned_id`, and `omitted_through_id` describe
  actual native IDs. IDs are per-buffer and can be sparse on newer WeeChat.
- Pages contain at most 500 lines and 512 KiB of serialized line data, with a
  768 KiB complete-response ceiling. Text is never silently shortened: an
  oversized individual line or metadata produces an explicit error. Cursor
  seeking walks native pointers on WeeChat's event loop; it creates no index.
- Cursors are buffer-bound, opaque and tamper-checked. They expire on adapter
  reload/process restart, buffer close/recreation, or when their anchor line is
  cleared/pruned. An expired cursor errors explicitly; start a fresh read.
- WeeChat's own buffer limits, clears, closes and process lifetime determine
  retention. Plugin reload keeps existing native lines; normal process restart
  does not preserve them through this adapter. There is no logger-file import,
  IRC-server-history fetch, screenshot reading, or extra persistence layer.
- Formatted buffers require native line IDs (WeeChat 3.8+); free-content buffers
  are rejected explicitly. Actual field types are discovered at runtime so both
  integer and newer longlong native IDs are read correctly.

A command result confirms only local dispatch. To inspect subsequent output,
read an exposed buffer, then read again after native resource-change events or
when a delayed server reply is expected. Output can be interleaved, routed to a
server/core buffer, or arrive later; the adapter does not invent command/output
correlation or claim command completion. Unexposed destination buffers remain
unreadable until separately allowed.

```json
{"name":"weechat_msg","arguments":{"buffer":"irc.railway.#wchat","arguments":"hello"}}
```

Arguments cannot override the selected channel. Control characters and multiline
commands are rejected. Arbitrary `exec`, scripting, server configuration and
secret-bearing commands are not exposed. A successful result means local command
acceptance, not delivery confirmation. Add typed scoped adapters for new commands
rather than a generic command escape hatch.

`resources/list` discovers allowed buffers. `resources/read` returns the same
native buffer data shape, with at most 500 newest lines. Use `weechat_buffers`
with the returned cursor for older pages. The SDK's `subscriptions/listen` acknowledges
requested resource URIs before delivering correlated resource-change events.
Clients reread the resource after an event. Closing the listen context cancels
that stream; reconnecting requires a fresh listen and catch-up read.

For separate IRC identities, run separate WeeChat profiles and nicknames. Multiple
MCP connections to one profile share that profile's IRC identity. A host must
consume notifications and explicitly schedule turns; MCP does not wake a model
on its own. Incoming IRC content is untrusted data, never tool authorization.

## Mention-triggered host experiment

The live test uses two distinct WeeChat profiles and deterministic host callbacks:

1. An independent observer mentions A; A queues the message and sends B a question.
2. B wakes on the mention. While B is busy, it disconnects its MCP client and an
   additional mention arrives; reconnect and catch-up recover the pending line.
3. B replies and A wakes. Duplicate resource events do not enqueue old messages.
4. B's remaining message stays queued because its turn limit is exhausted.

SQLite cursor advancement and enqueueing are atomic. Message identity is buffer
epoch plus native line ID (stored internally as ID + 1). Own messages, non-IRC lines and nickname substrings are
ignored. Omitted rows and native-retention uncertainty fail closed. Intake continues while a turn runs. An uncertain
running turn stays blocked after a crash for reconciliation rather than resending.
The SQLite file must be private to each agent/buffer. History in WeeChat is bounded
and in-memory, so reconnect catch-up cannot recover evicted or pre-restart lines.
There is no exactly-once network delivery guarantee and no automatic command retry.

This is a host scheduling/transport experiment, not an autonomous model runtime.
No model credentials, model calls or new spending are involved.

## Verify

```sh
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run python -m unittest discover -s . -v
uv run python -m py_compile *.py
git diff --check
```

The real integration runs official Debian WeeChat 4.6.3 and miniircd on localhost:

```sh
uv run python native_buffer_live_test.py --weechat-root /tmp/weechat-runtime/root
uv run python live_test.py --weechat-root /tmp/weechat-runtime/root --miniircd /tmp/weechat-miniircd/miniircd
```

The root contains official Debian `weechat-headless`, `weechat-core`,
`weechat-plugins` and `weechat-python` packages extracted with `dpkg-deb -x`, with
compatible shared libraries installed on the host. CI installs WeeChat packages
from Ubuntu and checks out a pinned commit of official miniircd.

The offline native-buffer test prints 650 lines before loading the MCP plugin,
then verifies real IPC reads, pagination/order, filter metadata, plugin reload,
clear, WeeChat retention limits, and process restart without an adapter archive.

The IRC test creates temporary profiles and an ephemeral local IRC server, verifies
modern MCP resource events, cancellation, send/receive, two separate identities and
the bounded host experiment, then stops all processes. It never joins an external
IRC server or deploys a public listener.

For isolated environments without Unix sockets, set `WEECHAT_MCP_LOOPBACK_PORT=0`.
The plugin binds only 127.0.0.1 and writes the port to `<data dir>/mcp/loopback-port`.
Launch `bridge.py --loopback-port PORT`. This test mode has no authentication:
never use it in an untrusted network namespace, forward it, or expose private
accounts. The default Unix socket uses filesystem access controls.

## Sources

- [Official WeeChat hdata API](https://weechat.org/files/doc/stable/weechat_plugin_api.en.html#_hdata)
- [Official WeeChat buffer API](https://weechat.org/files/doc/stable/weechat_plugin_api.en.html#_buffers)

- [FastMCP resources](https://gofastmcp.com/servers/resources)
- [FastMCP providers](https://gofastmcp.com/servers/providers)
- [Official Python MCP SDK](https://github.com/modelcontextprotocol/python-sdk)
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [WeeChat API](https://weechat.org/files/doc/devel/weechat_plugin_api.en.html)
- [Debian WeeChat packages](https://deb.debian.org/debian/pool/main/w/weechat/)
- [miniircd](https://github.com/jrosdahl/miniircd)

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). Developed in the
[r33drichards WeeChat fork](https://github.com/r33drichards/weechat), based on
upstream [WeeChat](https://github.com/weechat/weechat), maintained by Sébastien
Helleu and contributors. WeeChat and miniircd are separate runtime dependencies
with their own notices and licenses.

## Generated full-command mapping (local opt-in)

The default deployment policy remains the original six scoped adapters. The new
mapping is deliberately separate from permission to expose or execute full
WeeChat control. **Do not enable this on a public service without a separate
access-policy review.** Full control includes shell/process commands, config,
script loading, server management, and commands which execute other commands.
Neither schema validation nor buffer selection is a sandbox for those effects.

For an isolated profile, launch WeeChat with `WEECHAT_MCP_FULL_CONTROL=1`. The
bridge then discovers one `weechat_cmd_<plugin>_<command>_<identity-hash>` tool for
every current command-hook registration, with no command allowlist ceiling.
`weechat_command_manifest` returns the versioned inventory and coverage counts;
`weechat_command_contexts` lists exact execution buffers, including core and
plugin buffers. Existing buffer data, resources and their read allowlist
are unchanged. No new streams, tasks, listeners or response collectors are added.

Runtime metadata is authoritative: command name, plugin, description, args,
args_description, completion, keep_spaces_right and WeeChat version. Plugin
load/unload is reflected on each lookup and call. Tool identities distinguish
shadowed names; execution uses WeeChat's `/command <plugin> /<name>` dispatcher.
Each call requires the current `registry_revision`; help/version changes reject
stale calls until tools are rediscovered. Completion is retained as evidence,
not treated as an enum: completions can be dynamic, partial or advisory.

The dependency-free `command_manifest.py` compiles JSON Schema and serialization
plans from syntax metadata. These feed the existing Pydantic-backed FastMCP
`Tool` implementation and JSON Schema validation. There is no separate manually
maintained set of command-specific functions. Each command exposes:

- `buffer`: exact execution context, such as `core.weechat`
- `registry_revision`: the constant in the current tool schema
- `syntax`: `v0`, `v1`, etc. for parsed help alternatives, or `raw`
- `params`: named string placeholders and literal/enum tokens for that variant;
  raw mode instead accepts `{ "arguments": "verbatim WeeChat arguments" }`

Each `oneOf` alternative is a complete input object, including the required
`buffer` and `registry_revision` fields. This keeps those fields visible to hosts
that expose alternatives as standalone function signatures. Generator version 2
changes the revision constants; rediscover tools after upgrading. The bridge and
runtime still validate the full call, including variant parameters and revision.

Parsing is intentionally conservative: independent trailing optional arguments,
angle-bracket placeholders, literal words and explicit literal alternatives.
Placeholders remain strings; names like `port` do not prove numeric types. Empty
help, repetition, nested options, compound host/port expressions and ambiguous
syntax remain raw. Mixed commands expose the understood alternatives as well as
raw mode. Raw mode is always available for valid but undocumented forms.
This is exhaustive **command coverage**, not a claim of exhaustive strong typing.

Typed tokens reject whitespace, quotes and backslashes instead of pretending
that shell quoting matches every WeeChat callback. Raw mode preserves quoting,
semicolons and right-hand spaces verbatim (the actual callback still controls
trimming through keep_spaces_right). All modes reject CR/LF, other ASCII control
characters, and payloads over 16 KiB. Commands such as `/eval`, `/exec`, aliases,
and `/command` retain their deliberate interpreter semantics in full-control
mode. A successful result means `/command` dispatcher acceptance only. WeeChat
discards the target callback return code in this explicit-plugin wrapper, so the
result reports `dispatched: true` and `target_callback_status: "unavailable"`; it
cannot prove callback success, IRC delivery or asynchronous completion.

### Source evidence and reproducible verification

Extract C registrations and callback evidence without executing the source:

```sh
uv run python tools/extract_command_source.py /path/to/weechat --output /tmp/weechat-source.json
```

Optionally set `WEECHAT_MCP_SOURCE_MANIFEST=/tmp/weechat-source.json` when launching
WeeChat. Source metadata is attached to matching runtime registrations, with
unresolved/drift status rather than silently replacing current runtime syntax.
This works across macro/translation wrappers; unresolved expressions and dynamic
registration sites remain explicit evidence. Source revision and callback checks
are audit data, not a claim that arbitrary C semantics have been proven.

```sh
uv run python -m unittest discover -s . -p 'test_*.py'
uv run ruff check .
uv run ruff format --check .
uv run ty check --error-on-warning
uv run python tools/check_command_acceptance.py \
  --weechat-root /path/to/extracted/debian/packages \
  --report /tmp/weechat-command-coverage.json
```

The acceptance script creates a temporary profile, loads packaged plugins, never
configures/connects a server, validates every generated schema, and exercises only
read-only help and server-list fixtures through IPC and MCP stdio. It terminates
its isolated WeeChat process afterward. Tool inventory is checked against every
registration in that instance; dynamic scripts and installation-specific plugins
will naturally change the total. This does not test execution of destructive
commands, every callback's semantics, other WeeChat versions, or public access.

## Optional MCP Events

[MCP Events](MCP_EVENTS.md) adds explicit, per-chat webhook subscriptions for incoming messages or nick mentions in a chosen exposed IRC channel. It is disabled unless a private persistent `MCP_EVENTS_DB` path is configured. Startup, joining channels and ordinary tool calls never subscribe a chat. The host supplies its callback/signing secret only after the user explicitly asks to monitor a channel; unsubscribe stops that chat's grant. See the guide for authentication, replay limits, configuration and rollout.
