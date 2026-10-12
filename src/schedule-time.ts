import { Cron } from "croner";

export type ScheduleTiming =
	| { kind: "cron"; expression: string; timeZone: string }
	| { kind: "interval"; everyMs: number }
	| { kind: "once"; at: number };

/** Validate before persisting. Time zones are explicit; callers may default to UTC. */
export function validateScheduleTiming(
	timing: ScheduleTiming,
	now: number,
): void {
	if (!timing || typeof timing !== "object")
		throw new Error("Invalid schedule timing");
	if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime()))
		throw new Error("Invalid schedule time");
	switch (timing.kind) {
		case "interval":
			if (
				!Number.isSafeInteger(timing.everyMs) ||
				timing.everyMs < 60_000 ||
				!Number.isFinite(new Date(now + timing.everyMs).getTime())
			)
				throw new Error("Interval must be at least one minute");
			break;
		case "once":
			if (
				!Number.isSafeInteger(timing.at) ||
				timing.at <= now ||
				!Number.isFinite(new Date(timing.at).getTime())
			)
				throw new Error("One-shot time must be in the future");
			break;
		case "cron": {
			if (
				typeof timing.expression !== "string" ||
				timing.expression.trim().split(/\s+/).length !== 5
			)
				throw new Error(
					"Cron requires five fields (minute hour day month weekday)",
				);
			if (typeof timing.timeZone !== "string" || !timing.timeZone)
				throw new Error("Cron requires an explicit time zone");
			new Intl.DateTimeFormat("en", { timeZone: timing.timeZone }).format(now);
			const cron = new Cron(timing.expression, { timezone: timing.timeZone });
			if (!cron.nextRun(new Date(now)))
				throw new Error("Cron has no future occurrence");
			break;
		}
		default:
			throw new Error("Unknown schedule timing");
	}
}

/** Strictly after `after`; interval phases remain anchored to the previous due time. */
export function nextScheduleTime(
	timing: ScheduleTiming,
	after: number,
	previousDue?: number,
): number | null {
	switch (timing.kind) {
		case "once":
			return previousDue === undefined && timing.at > after ? timing.at : null;
		case "interval": {
			const anchor = previousDue ?? after;
			return (
				anchor +
				(Math.max(0, Math.floor((after - anchor) / timing.everyMs)) + 1) *
					timing.everyMs
			);
		}
		case "cron":
			return (
				new Cron(timing.expression, { timezone: timing.timeZone })
					.nextRun(new Date(after))
					?.getTime() ?? null
			);
	}
}
