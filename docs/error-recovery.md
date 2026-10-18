# Durable error recovery

The durable harness is the single owner of provider retry attempts. New sessions
allow three retries after the initial attempt, with 1/2/4-second backoff. The
attempt count and next-attempt timestamp are stored in the existing operation
checkpoint. Reopening a session does not reset a prepared generation's budget.
Provider SDK retries are disabled at the request hook, including reopened work.
No outer loop starts a second operation to retry a failed one.

Failed provider messages are classified into a fixed allowlist before the harness
makes its retry decision. Only rate-limit, server, and transport categories are
eligible. Cancellation, authentication/permission, quota/billing, invalid requests,
state-integrity failures, and unknown failures are not automatically retried.
Classification uses bounded provider text because the harness's stored operation
error has no structured provider error code; it is conservative, not a root-cause
diagnosis. Existing context-overflow compaction remains owned by the harness.

The live IRC progress path reports a committed retry schedule. Intermediate
assistant errors do not announce terminal failure. Final delivery and later
readback use fixed "Paused" or "Needs input" guidance from the settled result.
No arbitrary provider error, stack, cause, URL, or token is included in those
messages. Progress delivery is best-effort, like existing tool activity; final
replies retain the existing durable delivery receipts.

An MCP execution error is returned to the model for correction of the next step.
A thrown remote call failure is treated as potentially uncertain: inspect the
service or ask the user before repeating an action. Neither path automatically
replays a tool. Existing dispatch memos and replay-never guards remain unchanged.
Completed tools are not reexecuted when the following provider response retries.

Goal accounting is unchanged: intermediate retries do not fault a goal, while
terminal failure or cancellation pauses it. Process restart still pauses active
goals and revokes their old continuation inputs. This change does not add automatic
goal restart, automatic tool replay, or recovery from storage corruption.
