import { describe, expect, it } from "vitest";
import { failureDetail, isJoinFailure, JoinRefusedError, JoinTracker } from "../src/irc/join.ts";

function tracker(options: { timeoutMs?: number } = {}) {
	const issued: string[] = [];
	const joins = new JoinTracker({
		issue: (channel) => issued.push(channel),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
	return { joins, issued };
}

describe("join confirmation", () => {
	it("resolves only when the server confirms the join", async () => {
		const { joins, issued } = tracker();
		let settled = false;
		const pending = joins.join("#alpha").then(() => {
			settled = true;
		});
		expect(issued).toEqual(["#alpha"]);
		// A JOIN is a request: nothing is true until the server answers.
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(joins.has("#alpha")).toBe(false);

		joins.onJoined("#alpha");
		await pending;
		expect(joins.has("#alpha")).toBe(true);
		// Already in: no second JOIN, and no waiting.
		await joins.join("#ALPHA");
		expect(issued).toEqual(["#alpha"]);
	});

	it("rejects the join the server refused, naming the channel and the remedy", async () => {
		const { joins } = tracker();
		const pending = joins.join("#full");
		joins.onError({ error: "too_many_channels", channel: "#full", reason: "You are on too many channels" });
		await expect(pending).rejects.toThrow(
			"cannot join #full: You are on too many channels; ,part a channel to free a slot",
		);
		expect(joins.has("#full")).toBe(false);
	});

	it("ignores errors that do not answer a pending join", () => {
		const { joins } = tracker();
		expect(joins.onError({ error: "cannot_send_to_channel", channel: "#other" })).toBe(false);
		expect(joins.onError({ error: "too_many_channels" })).toBe(false);
		// A refusal for a channel nobody is waiting on is not ours to consume.
		expect(joins.onError({ error: "banned_from_channel", channel: "#nowhere" })).toBe(false);
	});

	it("gives up when the server never answers", async () => {
		const { joins } = tracker({ timeoutMs: 10 });
		await expect(joins.join("#silent")).rejects.toThrow(/no reply to JOIN #silent/);
	});

	it("forgets membership on part, kick and disconnect", async () => {
		const { joins } = tracker();
		const joined = joins.join("#a");
		joins.onJoined("#a");
		await joined;
		joins.onLeft("#A");
		expect(joins.has("#a")).toBe(false);

		const second = joins.join("#b");
		joins.onJoined("#b");
		await second;
		const pending = joins.join("#c");
		joins.onDisconnected();
		expect(joins.has("#b")).toBe(false);
		await expect(pending).rejects.toThrow(/disconnected before joining #c/);
	});

	it("shares one JOIN between concurrent callers", async () => {
		const { joins, issued } = tracker();
		const first = joins.join("#shared");
		const second = joins.join("#shared");
		expect(issued).toEqual(["#shared"]);
		joins.onJoined("#shared");
		await Promise.all([first, second]);
		expect(joins.has("#shared")).toBe(true);
	});

	it("classifies which server replies answer a join", () => {
		expect(isJoinFailure("too_many_channels")).toBe(true);
		expect(isJoinFailure("invite_only_channel")).toBe(true);
		expect(isJoinFailure("cannot_send_to_channel")).toBe(false);
		const refused = new JoinRefusedError("#x", "the channel is invite-only (+i)");
		expect(refused.message).toBe("cannot join #x: the channel is invite-only (+i)");
		// Callers that are not joining ("cannot post to #x: …") want the reason alone.
		expect(failureDetail(refused)).toBe("the channel is invite-only (+i)");
		expect(failureDetail(new Error("plain"))).toBe("plain");
	});
});
