import { publicError } from "./public-error.ts";
import { runIrc } from "./run.ts";

try { await runIrc({}); }
catch (error) {
 console.error("cuse startup failed:", publicError(error));
 process.exitCode = 1;
}
