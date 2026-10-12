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
