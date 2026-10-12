import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableIrcStore } from "../src/durable-store.ts";
import {
	nextScheduleTime,
	validateScheduleTiming,
} from "../src/schedule-time.ts";

const start = Date.parse("2026-10-09T00:00:00Z");
const input = {
	id: "daily",
	channel: "#test",
	sender: "user",
	prompt: "Check progress",
	timing: { kind: "interval" as const, everyMs: 60_000 },
};
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cuse-scheduler-"));
	const store = new DurableIrcStore(dir);
	return {
		dir,
		store,
		close: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("recurrence advance and inbox survive restart and never duplicate due occurrence", () => {
	const f = fixture();
	let store = f.store;
	try {
		store.addSchedule(input, start);
		const accepted = store.enqueueDueSchedules(start + 600_000);
		assert.equal(accepted.length, 1);
		assert.equal(accepted[0].id, `schedule/daily/${start + 60_000}`);
		assert.equal(store.listSchedules()[0].nextRunAt, start + 660_000);
		store.close();
		store = new DurableIrcStore(f.dir);
		assert.equal(store.enqueueDueSchedules(start + 600_000).length, 0);
		assert.equal(store.listInbox().length, 1);
	} finally {
		store.close();
		f.close();
	}
});
test("pending, running and interrupted occurrences coalesce without backlog", () => {
	const f = fixture();
	let store = f.store;
	try {
		store.addSchedule(input, start);
		store.enqueueDueSchedules(start + 60_000);
		assert.equal(store.enqueueDueSchedules(start + 120_000).length, 0);
		const run = store.claimNext()!;
		assert.equal(store.enqueueDueSchedules(start + 180_000).length, 0);
		store.close();
		store = new DurableIrcStore(f.dir);
		assert.equal(store.listInbox()[0].state, "recovery-required");
		assert.equal(store.enqueueDueSchedules(start + 240_000).length, 0);
		store.retry(run.id);
		store.claimNext();
		store.complete(run.id);
		assert.equal(store.enqueueDueSchedules(start + 300_000).length, 1);
		assert.equal(store.listInbox().length, 2);
	} finally {
		store.close();
		f.close();
	}
});
test("skip startup policy drops missed occurrences; regular ticks run and channels isolate", () => {
	const f = fixture();
	try {
		f.store.addSchedule({ ...input, missedPolicy: "skip" }, start);
		assert.equal(
			f.store.enqueueDueSchedules(start + 600_001, { recovering: true }).length,
			0,
		);
		assert.equal(f.store.listSchedules()[0].nextRunAt, start + 660_000);
		assert.equal(
			f.store.enqueueDueSchedules(start + 660_001, {
				eligibleChannels: ["#other"],
			}).length,
			0,
		);
		assert.equal(
			f.store.enqueueDueSchedules(start + 660_001, {
				eligibleChannels: ["#test"],
			}).length,
			1,
		);
		assert.throws(
			() => f.store.setSchedulePaused("#other", "daily", true),
			/not found/,
		);
		assert.equal(f.store.deleteSchedule("#other", "daily"), false);
	} finally {
		f.close();
	}
});
test("pause/resume skips intentionally paused time; one shots run once", () => {
	const f = fixture();
	try {
		f.store.addSchedule(input, start);
		f.store.setSchedulePaused("#test", "daily", true, start);
		assert.equal(f.store.enqueueDueSchedules(start + 600_000).length, 0);
		f.store.setSchedulePaused("#test", "daily", false, start + 600_000);
		assert.equal(f.store.listSchedules()[0].nextRunAt, start + 660_000);
		f.store.addSchedule(
			{ ...input, id: "once", timing: { kind: "once", at: start + 1000 } },
			start,
		);
		assert.equal(f.store.enqueueDueSchedules(start + 2000).length, 1);
		assert.equal(
			f.store.listSchedules().find((s) => s.id === "once")!.nextRunAt,
			null,
		);
		assert.equal(f.store.enqueueDueSchedules(start + 3000).length, 0);
	} finally {
		f.close();
	}
});
test("failed inbox insertion rolls recurrence back atomically", () => {
	const f = fixture();
	try {
		f.store.addSchedule(input, start);
		f.store.enqueue({
			id: `schedule/daily/${start + 60_000}`,
			channel: "#test",
			sender: "user",
			body: "collision",
		});
		assert.throws(
			() => f.store.enqueueDueSchedules(start + 60_000),
			/collision/,
		);
		assert.equal(f.store.listSchedules()[0].nextRunAt, start + 60_000);
		assert.equal(f.store.listSchedules()[0].lastMessageId, null);
	} finally {
		f.close();
	}
});
test("cron uses explicit timezone across DST and rejects invalid schedules", () => {
	const timing = {
		kind: "cron" as const,
		expression: "0 9 * * *",
		timeZone: "America/Los_Angeles",
	};
	validateScheduleTiming(timing, start);
	assert.equal(
		nextScheduleTime(timing, Date.parse("2026-10-31T17:00:00Z")),
		Date.parse("2026-11-01T17:00:00Z"),
	);
	assert.throws(() =>
		validateScheduleTiming({ ...timing, timeZone: "Fake/Zone" }, start),
	);
	assert.throws(
		() =>
			validateScheduleTiming({ ...timing, expression: "* * * * * *" }, start),
		/five/,
	);
	assert.throws(
		() => validateScheduleTiming({ kind: "interval", everyMs: 10 }, start),
		/minute/,
	);
	assert.throws(
		() => validateScheduleTiming({ kind: "once", at: start }, start),
		/future/,
	);
});
test("mutation receipts survive restart; failed receipt rolls back schedule and ID reservation", () => {
	const f = fixture();
	let store = f.store;
	try {
		assert.throws(
			() =>
				store.scheduleOperation("create-fail", "one", () => {
					store.addSchedule(input, start);
					throw new Error("crash");
				}),
			/crash/,
		);
		assert.equal(store.listSchedules().length, 0);
		const result = store.scheduleOperation("create", "one", () =>
			store.addSchedule(input, start),
		);
		store.close();
		store = new DurableIrcStore(f.dir);
		assert.deepEqual(
			store.scheduleOperation("create", "one", () => {
				throw new Error("must not run");
			}),
			result,
		);
		assert.throws(
			() => store.scheduleOperation("create", "changed", () => false),
			/collision/,
		);
		assert.equal(
			store.scheduleOperation("delete", "two", () =>
				store.deleteSchedule("#test", "daily"),
			),
			true,
		);
		assert.equal(
			store.scheduleOperation("delete", "two", () => {
				throw new Error("must not run");
			}),
			true,
		);
		assert.throws(() => store.addSchedule(input, start));
	} finally {
		store.close();
		f.close();
	}
});
test("schedule limits reject oversized prompts and runaway per-channel creation", () => {
	const f = fixture();
	try {
		assert.throws(
			() => f.store.addSchedule({ ...input, prompt: "x".repeat(8001) }, start),
			/8000/,
		);
		for (let i = 0; i < 100; i++)
			f.store.addSchedule({ ...input, id: `job-${i}` }, start);
		assert.throws(
			() => f.store.addSchedule({ ...input, id: "overflow" }, start),
			/100/,
		);
		assert.equal(
			f.store.addSchedule({ ...input, id: "other", channel: "#other" }, start)
				.channel,
			"#other",
		);
	} finally {
		f.close();
	}
});
