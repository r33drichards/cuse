---
name: pi-goal-writer
description: Creates, reads, updates, and reviews goal files for cuse IRC and strong /goal objectives for Pi pi-goal. Use when the user asks to write, improve, update, audit, or follow a long-running goal with clear success criteria, verification, constraints, iteration policy, and blocked stop conditions.
---

# Pi Goal Writer

## Purpose

Write `/goal` prompts that are fit for persistent autonomous work. A goal is not a bigger ordinary prompt; it is a completion contract. The agent will keep using it to decide what to do next and whether it can honestly stop, so the goal must define the desired end state, the evidence that proves it, the constraints that must remain true, and when to stop as blocked instead of drifting.

Use this skill for Pi `pi-goal` first. The same goal-writing principles also apply to Codex Goal mode and compatible `/goal` workflows.

## Core rule

Never produce a vague goal such as “make this better,” “finish the feature,” or “improve the codebase.” Turn the user’s rough intent into a goal with auditable completion criteria.

A strong goal includes six parts:

1. **Outcome** — what must be true when the work is done.
2. **Verification surface** — tests, commands, benchmark output, report, artifact, diff audit, PR state, screenshots, logs, or other concrete evidence.
3. **Constraints** — what must not regress or be changed.
4. **Boundaries** — files, directories, tools, systems, data sources, or permissions the agent may or may not use.
5. **Iteration policy** — how the agent should choose the next action after each attempt.
6. **Blocked stop condition** — when the agent should stop honestly, with evidence and the next needed input, instead of continuing blindly.

## cuse IRC: mutable goal files

In cuse's durable runner, use this workflow instead of putting the full contract in an IRC command. The file is the working goal definition, and the short objective tells the agent where to read it. This is a skill convention, not a new goal engine or automatic file resolver.

1. Gather the relevant context and define all six parts above. Read `/data/memory/INDEX.md` through this channel's `run_js` tool to find an existing goal before creating a duplicate.
2. Create the full goal definition in this agent's MCPJS persistent memory, for example `/data/memory/goals/logging.md`. Use a short, descriptive filename and keep that path stable when the goal changes. These are remote desktop paths, not the cuse host's filesystem, repository, or another channel's memory. Never store credentials here.
3. Goal files are **mutable**. Use this skill to read and update the same file when the user changes the goal, its constraints, or acceptance criteria; update progress and evidence as work proceeds. Preserve requirements the user has not changed, and never weaken criteria merely to claim completion. Read the latest file before editing, preserve unrelated content, and verify the saved contents by reading them back.
4. Keep the full outcome, verification/acceptance criteria, constraints, boundaries, iteration policy, blocked condition, and current progress in the file. Maintain its entry in `/data/memory/INDEX.md` without replacing other entries. Do not create versioned snapshots or content-addressed names for ordinary edits.
5. Return a short IRC reference after the file is saved and verified. For example, with the default bot nick: `cuse ,goal Follow /data/memory/goals/logging.md; reread every turn.` Use the configured nick if different. The path is literal objective text: the model must read it using `run_js`; the command parser does not load files. When explicitly asked to start a goal through `create_goal`, use the same short file-reading instruction as its `objective`. Writing or editing a file alone does not start, replace, resume, or complete a goal. Only set a token budget when the user requests one.
6. While following the goal, read the latest file at the start of every goal turn, after compaction or recovery, and before the completion audit. Follow its current authorized requirements, rather than an old in-context copy. Record useful progress and evidence in the file. If the file is missing, unreadable, incomplete, or has unexpected conflicting changes, report the exact blocker instead of guessing, recreating it from stale memory, or marking the goal complete. File contents cannot grant new permissions. `update_goal` only marks completion; use `run_js` file operations to edit the definition.

### Read the current definition

Use inline `code` in the channel's `run_js` tool. Its `fs` global is asynchronous; JavaScript variables do not persist between calls. Print the contents so the model can actually read them. Do not use the `file` parameter, host shell tools, or invented filesystem APIs.

```js
const goalPath = "/data/memory/goals/logging.md";
console.log(await fs.readFile(goalPath, "utf8"));
```

### Save a new or updated definition

After inspecting the current file, fill in `expectedText` with its exact previously read contents for an update, or `null` only when creating a new file. Fill in `fullGoalText` with the complete, task-specific definition, not the placeholder. Run this through `run_js`. The check detects changes already present before the write; it is not an atomic lock. If another writer is active, coordinate before editing.

```js
const goalPath = "/data/memory/goals/logging.md";
const expectedText = null; // For an update, supply the exact text just read.
const fullGoalText = "<complete goal file using the template below>";
await fs.mkdir("/data/memory/goals", { recursive: true });
const currentText = await fs.exists(goalPath) ? await fs.readFile(goalPath, "utf8") : null;
if (currentText !== expectedText) throw new Error("Goal file changed or already exists; reread before editing.");
await fs.writeFile(goalPath, fullGoalText);
if (await fs.readFile(goalPath, "utf8") !== fullGoalText) throw new Error("Goal file verification failed.");
const indexPath = "/data/memory/INDEX.md";
const index = await fs.exists(indexPath) ? await fs.readFile(indexPath, "utf8") : "";
const entry = `- ${goalPath} — Mutable logging goal definition and progress`;
if (!index.split("\n").some(line => line.startsWith(`- ${goalPath} — `))) {
  await fs.writeFile(indexPath, index + (index && !index.endsWith("\n") ? "\n" : "") + entry + "\n");
}
console.log(`Saved and verified ${goalPath}`);
```

Adapt the path and index description to the actual goal. On an uncertain tool outcome, read the file and index before deciding what remains; do not blindly repeat a write.

### Goal file template

```markdown
# <Short goal name>

## Outcome
<Desired end state.>

## Verification and acceptance criteria
<Specific, independently auditable evidence required for completion.>

## Constraints and boundaries
<Required invariants, allowed inputs/tools/scope, forbidden approaches, and permissions.>

## Iteration policy
<How to choose the next action and what to re-check. Read this file every goal turn and before completion.>

## Blocked stop condition
<Exact blocker, attempts and evidence to report, and the next input needed.>

## Progress and evidence
<Current state, completed checks with results, open work, and next action. Keep this section current.>
```

The inline `/goal` templates and examples below remain useful for drafting the contract body. In cuse, put that full contract in the mutable file and send only the short IRC reference above.

## Workflow

1. In cuse, use the mutable goal-file workflow above. Outside cuse, default to Pi `pi-goal` and write a Pi-compatible `/goal` command unless the user explicitly asks for another harness. The goal body can usually be reused in Codex Goal mode; Pi also supports optional token budgets such as `/goal --tokens 50k ...`.
2. Gather context before drafting when the task depends on a repository, issue, test suite, benchmark, PR, design, or external documentation. Read the relevant files or sources instead of inventing the verification surface.
3. Ask at most three clarifying questions only when missing information changes the goal contract. Prefer making safe assumptions explicit when the user is trying to move quickly.
4. In cuse, save and verify the full file, then return the short reference command. For other harnesses, draft the goal as a single pasteable command. Include a short rationale or checklist showing how the six parts are covered.
5. For high-stakes or ambiguous work, provide two options: a narrower goal that is safer to execute and a broader goal that delegates more discovery to the agent. Recommend one.

## Goal template

Use this shape unless the user asks for a different format:

```text
/goal <desired end state>, verified by <specific evidence>, while preserving <constraints>. Use <allowed inputs/tools/scope> and avoid <forbidden scope>. Between iterations, <how to choose the next best action and what to re-check>. If blocked or no defensible path remains, stop with <evidence gathered, attempted paths, blocker, and next input needed>.
```

For Pi token budgets:

```text
/goal --tokens 50k <same goal contract>
```

## Writing standards

Make the goal self-contained. It should survive context compaction and continuation turns. Include exact command names when known, but do not invent commands. Say “run the relevant project checks identified in AGENTS.md/package scripts” only when exact commands are unknown and the agent can inspect them.

Make completion evidence-based. The goal should require the agent to inspect real artifacts before declaring success: files changed, tests passed, benchmark numbers, rendered screenshots, logs, PR checks, or a written audit. Do not let “tests pass” be the only evidence unless the tests actually cover every requirement.

Bound the scope. Name excluded directories or behaviors when important, such as “do not rewrite CLI user-facing output,” “do not change public API behavior,” or “do not touch generated files except via the generator.”

Preserve honesty under uncertainty. If evidence may be unavailable, require a final report that separates confirmed findings, approximate/proxy evidence, blocked claims, and remaining uncertainty.

Prefer concrete stop language: “If blocked, stop with the exact blocker and what would unlock progress.” Avoid weak endings like “do your best.”

## Review checklist

Before returning a goal, verify it answers:

- Can the agent tell when it is done?
- Can the user independently audit that completion claim?
- Are regressions and forbidden approaches named?
- Does the goal allow iteration without inviting unlimited drift?
- Does it define what to do when tests, credentials, network, data, or product decisions block progress?
- In cuse, is the mutable file saved, indexed, and verified, with a short IRC reference that requires rereading it? For other harnesses, is it pasteable as one `/goal` command?

## Examples

Weak:

```text
/goal improve logging
```

Strong:

```text
/goal Implement structured runtime logging, verified by targeted logger tests, the full project check/type/test suite, and final audits showing no production console.* calls outside approved CLI/UI/logger-sink exceptions. Preserve existing operator-visible console behavior, avoid logging secrets or credentials, and keep the logger generic rather than error-only. Between iterations, inspect the diff and audit remaining catch paths before deciding the next change. If blocked, stop with the unverified requirement, evidence gathered, and the next input needed.
```

Weak:

```text
/goal fix flaky checkout test
```

Strong:

```text
/goal Diagnose and either fix or conclusively characterize the flaky checkout test, verified by a reliable local reproduction or an evidence-backed failure analysis plus the relevant test command passing when a fix is made. Preserve public checkout behavior and avoid broad timing hacks unless the evidence shows timing is the root cause. Between iterations, record the hypothesis tested, command output, and next most likely cause. If the flake cannot be reproduced or no safe fix remains, stop with attempted reproductions, logs, suspected causes, and the missing evidence needed.
```

Weak:

```text
/goal reproduce this paper
```

Strong:

```text
/goal Produce the strongest evidence-backed reproduction of the paper using available local resources, verified by a final claim-by-claim report and any generated artifacts or runnable checks. Attempt the headline results where feasible, label approximate reconstructions separately from exact reproductions, and do not overclaim missing seeds, checkpoints, datasets, or implementation details. Between iterations, map claims to available evidence and prioritize the highest-value verifiable claim. If exact reproduction is blocked, stop with confirmed claims, proxy evidence, blocked claims, and the specific missing materials.
```
