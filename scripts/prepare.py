"""Validate maintained cuse sources against the pinned pi runtime, then stage them.

Unlike the old substring-rewrite generator this never overwrites local sources.
PI_SOURCE selects the already checked-out pi repository; no network is used.
"""
from pathlib import Path
import os
import subprocess
import runpy

ROOT = Path(__file__).resolve().parents[1]
PI = Path(os.environ.get("PI_SOURCE", str(ROOT / ".runtime/pi"))).resolve()
PIN = "d3e3b4ea7bd00e1e3784ac276a7c86fd1a5f1087"
REQUIRED = (
    "bot.ts", "channel-session.ts", "commands.ts", "session-commands.ts",
    "format.ts", "fault-domain.ts", "join.ts", "irc-framework.d.ts", "run.ts",
    "computer-use.ts", "state.ts", "tools.ts", "main.ts", "model-selection.ts",
)
head = subprocess.check_output(["git", "-C", str(PI), "rev-parse", "HEAD"], text=True).strip()
if head != PIN:
    raise SystemExit(f"Expected pi {PIN}, found {head}")
for name in REQUIRED:
    if not (ROOT / "src" / name).is_file():
        raise SystemExit(f"Missing maintained runtime source: {name}")
runpy.run_path(str(ROOT / "scripts" / "stage.py"), run_name="__main__")
