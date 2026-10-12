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

## pi-goal-x

pi-goal-x/ contains the complete tracked upstream source tree from
https://github.com/tmonk/pi-goal-x at 64c5ace87f3400c0b55ef87f2d2912167f53dbaa (v0.32.3).
Its MIT license and copyright are preserved unchanged. Per-file Git blob and
SHA-256 hashes are recorded in pi-goal-x.provenance.json. No submodule, npm
source download, Git metadata, local state, or dependencies are included.

This is an unmodified upstream snapshot, NOT automatically loaded into cuse.
It targets Pi 1.0-era APIs and interactive UI; cuse uses a separately pinned
Pi runtime and headless, per-channel durable scheduling. Integration requires
a reviewed adapter and tests rather than enabling the extension wholesale.
Keep cuse adaptations outside the snapshot so updates stay auditable.
