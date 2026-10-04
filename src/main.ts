import { runIrc } from "./run.ts";

try { await runIrc({}); }
catch (error) {
 console.error("cuse startup failed:", error instanceof Error ? error.message : String(error));
 process.exitCode = 1;
}
