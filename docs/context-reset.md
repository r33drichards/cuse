# Clear conversation context

In the agent's home channel, send `<agent-nick>: ,clear`. A bare `,clear`
works in the control channel (or when mentions are disabled).

This command starts an empty conversation branch without a summary. It makes
no model request. Old conversation entries and operation receipts remain in
the durable session database for administrator inspection/recovery; they are
not supplied as conversation history to subsequent model requests. This is
not secure deletion. There is currently no IRC command to restore a branch.

The desktop, browser login, disk files, working directory, model/thinking
settings, system instructions, and schedules are retained. Future scheduled
prompts still run, and tools can still read files on the desktop. Clear does
not erase saved file-based memory or replace the desktop.

## Preconditions

- Durable IRC mode is required. Classic extension sessions refuse the command
  because extension timers and callbacks cannot safely be reset this way.
- A running turn, opening session, queued message, or interrupted operation
  blocks clear. Wait for work to finish or inspect and resolve recovery, then
  send a new `,clear`. Clear does not cancel or replay uncertain side effects.
- If any persistent goal is set, use `,goal clear` first and wait for the
  current turn to finish. Paused and completed goals also retain objectives
  in the system context, so they must be cleared explicitly.

## Safety boundary

Eligibility is checked before a per-conversation gate is acquired. Intake
received after that boundary is saved durably and runs after clear finishes.
Other control commands are refused while the gate is held. A failed reset
never reports success and releases the intake gate.

The adapter refuses nonempty harness queues and active/suspended operations.
It accepts and drives only a non-summarizing navigation to the empty root,
without invoking the convenience navigation API's automatic follow-up run.
Navigation and its result use the harness's existing durable protocol. No
conversation entries, delivery receipts, schedules or desktop records are
deleted. A repeated IRC server message ID cannot execute clear again, and
replaying already-received messages cannot re-add their old prompts.

Restart reopens the same session and empty branch. If the process stopped
mid-command, its native command receipt prevents blind replay; inspect the
persisted operation before retrying. The existing navigation recovery protocol
can finish the same non-model navigation without repeating external actions.
