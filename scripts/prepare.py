"""Validate maintained cuse sources against the vendored pi runtime, then stage them.

Unlike the old substring-rewrite generator this never overwrites local sources.
PI_SOURCE selects the disposable staged pi source tree; no network is used.
"""
from pathlib import Path
import os
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]
PI = Path(os.environ.get("PI_SOURCE", str(ROOT / ".runtime/pi"))).resolve()
REQUIRED = (
    "bot.ts", "channel-session.ts", "commands.ts", "session-commands.ts",
    "format.ts", "fault-domain.ts", "join.ts", "irc-framework.d.ts", "run.ts",
    "computer-use.ts", "state.ts", "tools.ts", "main.ts", "model-selection.ts",
    "durable-session.ts", "durable-store.ts", "durable-delivery.ts", "durable-diagnostic.ts",
    "goal-types.ts", "goal-ledger.ts", "goal-tools.ts",
)
if not PI.is_relative_to((ROOT / ".runtime").resolve()):
    raise SystemExit("PI_SOURCE must be disposable under cuse/.runtime")
if json.loads((PI / "package.json").read_text()).get("name") != "pi-monorepo":
    raise SystemExit("Run npm run bootstrap to stage vendor/pi first")
for name in REQUIRED:
    if not (ROOT / "src" / name).is_file():
        raise SystemExit(f"Missing maintained runtime source: {name}")
runpy.run_path(str(ROOT / "scripts" / "stage.py"), run_name="__main__")
