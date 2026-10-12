import type { ScheduleTiming } from "./schedule-time.ts";

/** Relative one-shots are resolved by the durable store only on first creation. */
export type ScheduleInputTiming = ScheduleTiming | { kind: "delay"; afterMs: number };
export type ScheduleRequest =
 | { action: "create"; timing: ScheduleInputTiming; prompt: string; missedPolicy?: "catch-up-one" | "skip" }
 | { action: "list" }
 | { action: "pause" | "resume" | "delete"; id: string };

export const SCHEDULE_USAGE = "Usage: ,schedule list | pause/resume/delete ID | every 30m :: prompt | once 10m/ISO-date :: prompt | cron [IANA-timezone] 0 9 * * * :: prompt (default UTC)";

export function parseScheduleDuration(text: string): number | undefined {
 const match = /^(\d+)(s|m|h|d)$/i.exec(text);
 if (!match) return undefined;
 const factors: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
 const value = Number(match[1]) * factors[match[2]!.toLowerCase()]!;
 return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Syntax only; timing validity and authorization are checked before storage. */
export function parseScheduleCommand(argument: string): ScheduleRequest | undefined {
 const value = argument.trim();
 if (value === "list" || value === "") return { action: "list" };
 const mutation = /^(pause|resume|delete)\s+(\S+)$/.exec(value);
 if (mutation) return { action: mutation[1] as "pause" | "resume" | "delete", id: mutation[2]! };
 const separator = value.indexOf("::");
 if (separator < 0) return undefined;
 const parts = value.slice(0, separator).trim().split(/\s+/);
 const prompt = value.slice(separator + 2).trim();
 if (!prompt || prompt.length > 8000) return undefined;
 const kind = parts.shift();
 let timing: ScheduleInputTiming;
 if (kind === "every" && parts.length === 1) {
  const everyMs = parseScheduleDuration(parts[0]!);
  if (everyMs === undefined) return undefined;
  timing = { kind: "interval", everyMs };
 } else if (kind === "once" && parts.length === 1) {
  const afterMs = parseScheduleDuration(parts[0]!);
  if (afterMs !== undefined) timing = { kind: "delay", afterMs };
  else {
   // Require a timezone to avoid silently scheduling in the host's local timezone.
   if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(parts[0]!)) return undefined;
   const at = Date.parse(parts[0]!);
   if (!Number.isFinite(at)) return undefined;
   timing = { kind: "once", at };
  }
 } else if (kind === "cron" && (parts.length === 5 || parts.length === 6)) {
  const timeZone = parts.length === 6 ? parts.shift()! : "UTC";
  timing = { kind: "cron", expression: parts.join(" "), timeZone };
 } else return undefined;
 return { action: "create", timing, prompt };
}
