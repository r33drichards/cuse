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

The native profile and cursor are separate from Pi's durable session. Temporary IRC disconnects pause intake and sends while the same WeeChat process reconnects. A fresh own JOIN resumes only after native epoch/cursor continuity checks. Own kicks stay paused rather than automatically overriding the channel operator. A changed native history epoch, retention gap, or failed persistence stops that identity for reconciliation. Restart recovery requiring missing IRC
history must be reconciled by an operator; deleting a cursor is not automatic
recovery. Preserve the old profile/cursor and inspect server history and durable
inbox before deciding where intake can safely resume.

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
   peer budget, disconnected membership, callback failure, history-gap rejection,
   cursor persistence, and same durable session IDs after controlled recovery.

No merge or production deployment is implied by this code change.
