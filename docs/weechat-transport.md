# WeeChat transport migration

This replaces the shared IRC client and proprietary peer mailbox. It is not an
extension of PR #16. Durable Pi sessions, schedule state, goal ledgers, desktop
mappings and workspaces remain channel-local.

## Runtime boundary

One cuse Node process owns one headless WeeChat process, private profile and stdio
MCP client for each home channel. Native tool schemas and arguments are forwarded
unchanged. Home buffer subscriptions feed the existing durable inbox; sending a
native message never directly invokes another session. IRC delivery remains
at-least-once at the uncertain-send boundary, not exactly-once.

Each identity joins only its home and explicitly configured peer channels. Adding
peer access exposes that channel's history to that identity and enables posting;
review that access before deployment. The default has no cross-channel access.
Peer-target commands recheck native membership immediately before dispatch, without
subscribing peer traffic or waking the home model. History reads remain available
for diagnosis after a peer PART/KICK. An unobserved peer history gap or epoch
change blocks commands rather than assuming membership from a retained buffer.
An observed own JOIN in the same continuous history restores peer commands.

No credentials are generated and no HTTP port is opened. Existing IRC server
password configuration fails startup until an authenticated bootstrap is explicitly
implemented and reviewed. TLS verification stays enabled when IRC_TLS is true.

## Restart intake and durable receipts

Native line positions are process-local only. No `cursor.json` is read or written;
old positions are never read. Old file existence is only a one-time migration
indicator, inert once a reviewed cutoff has been saved. A fresh WeeChat process subscribes before reading all
available home-buffer lines, then handles later notifications through the same
serialized intake path. There is no skip-to-tail, message-ID ordering, batch wait,
or separate replay engine. Bounded server retention can leave a gap while Cuse is
offline; this change does not recover messages the server no longer holds.

Each input ID contains the configured network endpoint (lowercase hostname, port,
and TLS mode), canonical channel, and exact case-sensitive opaque server `msgid`.
Changing the configured endpoint changes its namespace and needs operator review.
Both WeeChat 3.8 `irc_tag_msgid_VALUE` and newer `irc_tag_msgid=VALUE` forms are
supported. Message tags and server-time are explicitly negotiated; batch is not
required. Missing, duplicate, or lossy IDs pause that identity with controlled
operator guidance. In particular, WeeChat 3.8 replaces commas with semicolons;
an underscore-form value containing a semicolon cannot be recovered exactly and
is refused. There is no text/time hash or local native-ID fallback.

Native runtime intake requires `CUSE_DURABLE_IRC=true`. Raw-event receipts use the
existing SQLite receipt store. A prompt's receipt, inbox admission, and peer-budget
effect commit atomically. Ignored-input receipts prevent a later mention-setting
change from making old chatter actionable. Replays are checked before prompt
framing or command classification changes. Pi sessions, existing pending inbox
work, goal ledgers, schedules, desktop mappings, and workspaces remain intact.

Commands reserve a durable receipt before any asynchronous/external action, then
mark it completed afterward. Completed commands are not repeated. An interrupted
or failed command remains explicitly uncertain and is logged, never automatically
retried. Inspect its effects before issuing a fresh command. This favors avoiding
repeated side effects over silently retrying an action that may already have run;
it is not an exactly-once guarantee for external systems.

Temporary IRC disconnects pause intake and sends while the same WeeChat process
reconnects. Own kicks remain paused. In-process native gaps/epoch changes still
stop that identity rather than inventing continuity; the position is discarded
when the identity closes. Failed durable writes stop intake without advancing
that position, and uncommitted receipt/inbox/budget writes roll back together.

## One-time legacy migration, subject to review

Legacy IDs hash `[channel, native epoch, native line ID]` and cannot establish
whether a server `msgid` has already executed. Startup rejects detected legacy
receipts or old cursor-file existence until an operator approves a cutoff. Nothing automatically resets,
deletes, converts, or chooses a production boundary.

The minimal rollout choice is `CUSE_WEECHAT_HISTORY_AFTER=<UTC ISO timestamp>`.
After backing up and inspecting the old state, choose a server-time boundary that
retires all potentially executed legacy history. This explicitly sacrifices any
unprocessed retained messages at or before the boundary. Existing durable inbox
work remains intact and can still resume through Pi's normal recovery path.
The cutoff commits once into the receipt database, survives later restarts without
the environment setting, and cannot be silently changed. Every future historical
input at/before it is ignored. Above it, exact server-ID receipts govern admission.
A missing/ambiguous server-time tag pauses intake whenever a cutoff applies.

The old cursor file also identifies command-only deployments whose commands never
wrote an inbox or schedule receipt. Its contents are never read, its position is
never reused, and after the reviewed migration receipt is saved its existence no
longer affects startup. Do not delete old files/receipts to bypass the review gate.
Inspect other restored or manually modified legacy deployments before enabling
replay; absence of evidence alone does not establish a new installation. An alternative pre-restart mapping would require trustworthy
native-line-to-server-ID evidence and a separately reviewed migration; no mapping
framework or automated production migration is included here.

## Readable channel nicknames

Nicknames now use the configured `IRC_NICK` prefix plus an adjective and animal,
such as `cuse-settling-mayfly` for `#alpha`, instead of a hexadecimal suffix.
The word lists come from pinned [`node-petname` 1.0.1](https://github.com/lcherone/node-petname).
A versioned channel hash selects words deterministically; startup does not use
the library's random generator. Channel case does not change the result. Long
prefixes are shortened to keep both words intact and the nick within 30 ASCII
characters. The IRC network must support this nickname length.

WeeChat receives up to five deterministic readable candidates and tries the next
one when the server rejects an occupied nickname. A saved native nickname is
tried first; if it is not among the generated candidates, the list has up to six
names. Its unbounded automatic alternate
nick generation stays disabled. If all candidates are occupied, JOIN readiness
times out without starting channel work. No existing IRC user is displaced.
The confirmed nick is atomically saved in `nick.json` beside the existing
per-channel `profile/` and `cursor.json`, before announcing JOIN readiness. It
is tried first after restart, even if the original candidate is now free.
Changing `IRC_NICK` explicitly selects names with the new prefix. Invalid saved
nickname data or persistence failures stop the identity for operator review.

Existing hash-named bots switch to readable names on their next approved
restart. Profile paths, durable session IDs, desktop mappings and cursors do not
move or reset. The existing native-epoch recovery gate still applies. Use the
nickname shown in the channel or `,channels` when addressing that channel's bot;
old hexadecimal mentions no longer address it. Back up `nick.json` with the rest
of the volume to preserve collision-resolved names across restores.

## Deployment gate

1. Back up the existing volume and stop its single writer.
2. Confirm no unresolved agent mailbox inputs or removed-tool calls remain. Startup
   is deliberately blocked when these exist; completed audit history is retained.
3. Verify the network accepts the distinct nick format, connection count and chosen
   authentication configuration. Do not silently drop an existing IRC password.
4. Approve the exact home/peer channel access map and per-channel processes.
5. Build and run the credential-free tests. Perform live validation only in
   explicitly approved disposable channels, using no real private content.
6. Confirm visible sender identities, own-message suppression, mention routing,
   peer budget, disconnected membership, callback failure, in-process gap rejection,
   fresh-process server-ID replay, and same durable session IDs after recovery.
7. Verify server `msgid` retention and the channel history mode/retention in approved
   disposable channels. The loopback CI fixture is not a production replay test.
8. Review and approve the one-time legacy cutoff and acknowledged bounded gap.

No merge or production deployment is implied by this code change.
