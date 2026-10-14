# Vendored source

`pi/` contains the complete tracked source tree from
https://github.com/r33drichards/pi at
`d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087`.
It was imported with `git archive`, without Git metadata, dependencies, or local files.
Upstream license notices remain in the source tree.

This is ordinary checked-in source, not a submodule or a download at build time.
Edit Pi here and cuse in `../src`. `npm run bootstrap` copies Pi into the ignored,
disposable `.runtime/pi` build directory, installs locked npm dependencies,
hydrates the committed model artifact, and stages cuse into the runtime.
Do not make maintained edits in `.runtime`. Docker builds copy this same tree.

For a future upstream update, import a reviewed revision, preserve any cuse
patches, update this provenance, and run the repository validation workflow.

## pi-goal

`pi-goal/` is the complete, unchanged Michaelliv/pi-goal v0.1.7 tracked tree at
`3f100be5434454d3388755a119d01caca9127c16`, imported with `git archive`.
Repository: https://github.com/Michaelliv/pi-goal
MIT license and copyright are preserved. `pi-goal.provenance.json` records each
file's Git blob and SHA-256; packaging tests verify the exact 15-file snapshot.

The extension itself is not loaded into the durable harness. The explicit host
port lives in `../src/pi-goal*.ts`: SQLite state/receipts and the durable inbox
replace extension globals and microtasks. Two pure TypeScript helpers are copied
byte-for-byte into `../src/pi-goal-upstream` for the runtime build, with an
integrity check against this snapshot. The continuation and budget prompts are
ported verbatim and checked too. See `../docs/pi-goal.md` for behavior differences.
The runtime writer skill is intentionally customized for mutable MCPJS
`/data/memory` goal files and short IRC references, as requested by the user.
The pristine skill remains in this snapshot. `runtimeCustomizations` in the
provenance manifest records original/local hashes and the purpose of this edit.
There is no dependency install or source download at runtime.
