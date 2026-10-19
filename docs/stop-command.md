# Stop current work

Type `,stop` in the agent's home IRC channel (or address its nickname with `,stop`). It works even when the channel normally requires a mention. Peers cannot execute human control commands.

- Interrupts the current inference/tool operation and discards work already queued for this session.
- Pauses its persistent goal without deleting the objective. Use `,goal resume` to continue deliberately.
- Preserves conversation history, context, desktop, browser state, files, model settings, and schedules.
- Future user messages and future scheduled runs still work. Other channels and their sessions are unaffected.
- Acknowledges after local cancellation has settled. Already dispatched external actions may still finish; cancellation does not undo them or confirm their outcome.

Durable mode commits cancellation intent and exact stopped input IDs before asynchronous cancellation. Interrupted cancellation is reconciled when the session next opens, so restart/recovery cannot replay stopped work. New messages arriving during cancellation wait behind it. Replayed native IRC command events are ignored; a new `,stop` establishes a fresh cutoff.

`,stop` is different from `,clear` (reset model context), `,goal pause` (allow the current turn to finish), and `,desktop stop` (stop the desktop and pause its delivery queue). It does not disable future schedules.
