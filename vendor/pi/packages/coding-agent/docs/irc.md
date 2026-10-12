# IRC (`pi irc`)

Implemented under `packages/coding-agent/src/irc/`.

`pi irc` joins an IRC network as a bot. Every channel it is in (and every DM
peer) has its own agent session, running in this process on the same
`AgentSession` runtime as interactive mode — so **installed pi extensions
load and work**. When the `mcpJs` setting names a coordinator, each channel's
`read`, `write`, and `run_js` act on that channel's own mcp-js filesystem
snapshot instead of the host, and pi's host file tools are switched off.

    pi irc --server irc.example --port 6667 --nick pi

## Extensions

Sessions load whatever is installed for the agent directory, so

    pi install npm:pi-schedule-prompt

gives every channel the extension's tools, and a scheduled prompt fires into
the channel it was scheduled from: the extension prompts its own session, and
the channel relays that turn like any other. Extensions that register slash
commands or message renderers load without error, but those surfaces are inert
here: the bot has no TUI. `,reload` reloads them.

## Talking to it

In a channel the bot only reacts to lines that mention its nick: a leading
address (`pi: list the files`, `pi, …`, `@pi …`) is stripped, and a mention
anywhere else (`does pi know?`) sends the whole line. Matching is
case-insensitive on whole words, so `piano` and `api` are not mentions.
Unmentioned chatter is never a prompt. DMs are addressed by nature and always
count. Reacting to every channel line is an explicit opt-in (`--all` /
`IRC_RESPOND_TO_ALL=1`) and off by default. Each line becomes the prompt `[IRC #chan] <nick> text` to that
channel's Session. While a turn runs, further lines are delivered as steering.
The bot relays every completed assistant message as channel lines, and one
line per tool call and result (`[run_js] 3 lines: …`, `[read] → hi`).

## Commands

Comma-prefixed. Inside a mention every command works in any channel the bot
is in (`pi ,model astra`, `pi ,fork ptest2`); bare `,command` lines are
honored in the control channel (default `#pi`) and DMs. Channel arguments
may omit the `#` (`ptest2` means `#ptest2`) and lists are comma separated.
`,help` lists all of them.

Session commands act on the channel's own Session and are the same set the
terminal client has as `/model`, `/thinking`, `/compact`, `/reload`
(parser in `session-commands.ts`):

| Command | Effect |
| --- | --- |
| `,model [query]` | No query: show the current model and the available ones. With a query: select the first model whose `provider/id name` contains it (case-insensitive), the same provider/id/name filter. |
| `,thinking [level]` | Set the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); no level cycles. |
| `,compact [instructions]` | Compact the Session context. |
| `,reload` | Reload the Session's plugins. |

Channel control commands:

| Command | Effect |
| --- | --- |
| `,join #a,#b` | Join channels; each gets a new Session (or its remembered one). |
| `,fork [#a,#b]` | Join each channel with a Session forked from the channel the command was typed in. With no channel, forks into a fresh `#<channel>-<petname>` (for example `#clone-brave-otter`, names from `node-petname`, retried if taken). The conversation tree is copied with `SessionManagement.fork`; with an mcp-js coordinator the source's latest heap and filesystem snapshot are carried over too (`engine-fork.ts`). The bot replies `forked #pi -> #a (session …; heap and files carried over)` per target. |
| `,part #chan` | Leave; the Session is kept and reused on the next `,join`. |
| `,merge #child [ours\|theirs]` | Merge a forked child's files back into this channel's Session: a three-way merge (`POST /api/fs/merge`) with base = the fork point's snapshot (recorded in the state file as `forkBaseFs`), ours = this Session's latest snapshot, theirs = the child's latest. On success the merged snapshot is folded into this Session's log, so `run_js` and the file tools see it at once. Conflicting paths are reported; `ours` or `theirs` resolves them. |
| `,sessions` | List channel → session. |
| `,help` | Command reference. |

Channel → session mappings live in `<agentDir>/irc/channels.json`
(`PI_IRC_STATE_DIR` or `--state-dir`), so a restart rejoins every remembered
channel and reattaches its Session.

## Delegation tools

Under `pi irc` every session worker also gets three tools, registered only
when the presentation's loopback control endpoint is configured
(`PI_IRC_CONTROL_URL` / `PI_IRC_CONTROL_TOKEN`, set for the workers by the
`pi irc` process; `control.ts`, `tools.ts`):

- `spawn_channel({ prompt, name?, timeoutSeconds? })`: forks the calling
  channel into `#<channel>-<petname>` (or `name`), joins it, runs `prompt` as
  the child's turn (its tool calls and reply appear in the child channel),
  waits for the child's run to finish through the Session services (with a
  timeout that aborts the child and returns partial text), and returns the
  child's final answer, channel, and session id.
- `irc_send({ channel, text })`: posts to a channel the bot is in, rate
  limited and line split. A mention of the bot in the text prompts that
  channel's Session, attributed to the sending channel, so channels can talk
  to each other in the open.
- `merge_channel({ channel, strategy? })`: the `,merge` command as a tool.

## Configuration

Flags win over environment variables:

| Flag | Env | Default |
| --- | --- | --- |
| `--server` | `IRC_SERVER` | required |
| `--port` | `IRC_PORT` | 6667, or 6697 with TLS |
| `--tls` | `IRC_TLS` | off |
| `--nick` | `IRC_NICK` | `pi` |
| `--password` | `IRC_PASSWORD` | none (server PASS) |
| `--channels` | `IRC_CHANNELS` | control channel only |
| `--control-channel` | `IRC_CONTROL_CHANNEL` | `#pi` |
| `--all` | `IRC_RESPOND_TO_ALL` | off |
| `--state-dir` | `PI_IRC_STATE_DIR` | `<agentDir>/irc` |
| `--session-dir` | `PI_IRC_SESSION_DIR` | `<agentDir>/irc/sessions` |
| | `PI_IRC_GUEST_NETWORK`, `PI_IRC_GUEST_MODULES` | what the sandbox may reach, for the `run_js` description |

The sandbox itself comes from the `mcpJs` coordinator setting; see
[settings.md](settings.md).


## How it is built

- `channel-session.ts`: one `AgentSession` per channel. It builds the
  channel's session file, its mcp-js sandbox (named after the pi session id so
  forks can carry engine state), its tools, and calls `bindExtensions()` —
  which every host must do, because extensions initialize on the
  `session_start` it emits. It relays `message_end` and
  `tool_execution_start`/`_end` to the channel, so anything that prompts a
  session (a channel line, a spawned parent, a scheduled prompt) shows up.
- `tools.ts`: `read`/`write`/`run_js` over the channel's sandbox, replacing
  pi's host file tools (`noTools: "builtin"` keeps extension tools enabled),
  plus `spawn_channel`/`irc_send`/`merge_channel` closing over the bot.
- `bot.ts`: irc-framework client, message routing, commands, and a per-target
  send queue with spacing to stay under flood limits.
- `engine-fork.ts`: carries mcp-js filesystem state across `,fork` and merges
  it back for `,merge`, over the coordinator's HTTP API.

A fork inherits the parent's conversation, so it is told where it now lives
and `irc_send` refuses to post back to the parent unless the user asked for
that channel by name.

## Sharing one process between channels

pi's session runtime expects a single `AgentSession` per process, and this bot
runs one per channel. That works, and is verified against a live network with
several channels open at once: a `pi-schedule-prompt` job fires, the model
answers, and the answer appears in the channel it was scheduled from, while
another channel is faulting. Two things make it hold.

- **A background timer in one channel's extension can throw against a context
  it captured earlier**, which reaches the process as an uncaught exception
  with nothing to say where it came from. Timers started by a channel's work
  carry that channel, so the failure is named against it, the bot keeps
  running, and every other channel is untouched.
- **The faulting session is left alone.** `AgentSession.dispose()` invalidates
  the extension runtime the whole process shares, so disposing one channel
  silently stops every other one. That is why a fault does not restart a
  session and why `,part` leaves it in memory.

- `fault-domain.ts`: names the channel a background failure came from, by
  running each channel's work in an `AsyncLocalStorage` domain that patched
  timers carry into their callbacks. It records who was running and nothing
  else — a callback is never wrapped in try/catch, because swallowing a throw
  the runtime expects to propagate leaves a promise unsettled and hangs the
  session.

Tests: `test/irc.test.ts` (commands, mentions, formatting, petnames, store,
engine fork over a fake coordinator, config, CLI parsing),
`test/irc-delegation.test.ts` (engine fork/merge, delegation tools, the
fork-reply policy), and `test/irc-resilience.test.ts` (fault attribution, and
regressions for the per-channel workspace and the send queue).
