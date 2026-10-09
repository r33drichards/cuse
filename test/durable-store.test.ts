import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DurableIrcStore } from "../src/durable-store.ts";

const input = { id: "in", channel: "#test", sender: "user", body: "hello" };
const output = { id: "in/reply", channel: "#test", text: "answer" };
test("store rejects overlapping writers, deduplicates and rolls back reply collisions", () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-store-"));
	const store = new DurableIrcStore(dir);
	try {
		assert.throws(() => new DurableIrcStore(dir), /Another IRC process/);
		assert.equal(store.enqueue(input), true);
		assert.equal(store.enqueue(input), false);
		assert.throws(
			() => store.enqueue({ ...input, body: "changed" }),
			/collision/,
		);
		store.claimNext();
		store.enqueueOutput(output);
		assert.throws(
			() => store.complete(input.id, [{ ...output, text: "changed" }]),
			/collision/,
		);
		assert.equal(store.listInbox()[0].state, "running");
		store.complete(input.id, [output]);
		assert.equal(store.listOutbox().length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("reopen preserves pending work and marks interrupted operations and delivery uncertainty", () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-store-"));
	let store = new DurableIrcStore(dir);
	try {
		store.enqueue(input);
		store.claimNext();
		store.enqueueOutput(output);
		store.claimOutput();
		store.close();
		store = new DurableIrcStore(dir);
		assert.equal(store.listInbox()[0].state, "recovery-required");
		assert.equal(store.claimNext(), undefined);
		assert.equal(store.claimOutput()?.deliveryUncertain, true);
		store.acknowledgeOutput(output.id);
		store.retry(input.id);
		assert.equal(store.claimNext()?.id, input.id);
		store.close();
		store = new DurableIrcStore(dir);
		assert.equal(store.claimOutput(), undefined);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("SIGKILL releases ownership without losing committed incoming work", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-store-"));
	const script = join(dir, "owner.mjs");
	writeFileSync(
		script,
		`import {DurableIrcStore} from ${JSON.stringify(new URL("../src/durable-store.ts", import.meta.url).href)};
 const store = new DurableIrcStore(${JSON.stringify(dir)}); store.enqueue(${JSON.stringify(input)}); store.claimNext();
 console.log('ready'); setInterval(() => store.listInbox(), 100);`,
	);
	const child = spawn(process.execPath, [script], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let errors = "";
	child.stderr.on("data", (data) => {
		errors += String(data);
	});
	try {
		await Promise.race([
			new Promise<void>((resolve) => {
				let stdout = "";
				child.stdout.on("data", (data) => {
					stdout += String(data);
					if (stdout.split("\n").includes("ready")) resolve();
				});
			}),
			once(child, "exit").then(() => {
				throw Error(errors);
			}),
		]);
		assert.equal(child.exitCode, null);
		assert.equal(child.signalCode, null);
		assert.equal(child.kill(0), true);
		assert.throws(() => {
			const unexpected = new DurableIrcStore(dir);
			unexpected.close();
		}, /Another IRC process/);
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const recovered = new DurableIrcStore(dir);
		try {
			assert.equal(recovered.listInbox()[0].state, "recovery-required");
		} finally {
			recovered.close();
		}
	} finally {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("peer metadata survives restart and question completion atomically creates one answer", () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-peer-"));
	let store = new DurableIrcStore(dir);
	const question = {
		...input,
		peer: {
			kind: "question" as const,
			source: "#source",
			rootId: "root",
			ancestry: ["#source", "#test"],
		},
	};
	try {
		store.enqueue(question);
		assert.throws(
			() =>
				store.enqueue({
					...question,
					peer: { ...question.peer, rootId: "changed" },
				}),
			/collision/,
		);
		store.claimNext();
		store.close();
		store = new DurableIrcStore(dir);
		assert.deepEqual(store.listInbox()[0].peer, question.peer);
		store.retry(input.id);
		store.claimNext();
		const answer = store.complete(input.id, [output], "complete answer");
		assert.ok(answer);
		assert.equal(answer.id, "in/answer");
		assert.equal(answer?.channel, "#source");
		assert.equal(answer?.peer?.kind, "answer");
		assert.equal(answer?.peer?.rootId, "root");
		assert.match(answer.body, /not human authorization/);
		assert.match(answer.body, /hello/);
		assert.match(answer.body, /complete answer/);
		store.close();
		store = new DurableIrcStore(dir);
		assert.equal(store.enqueue(question), false);
		assert.equal(store.listInbox().length, 2);
		assert.equal(store.listOutbox().length, 1);
		assert.throws(() => store.complete(input.id, [output]), /not running/);
		store.claimNext("#source");
		store.complete("in/answer");
		assert.equal(store.listInbox().length, 2);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("peer answer ID collision rolls back question completion and outgoing replies", () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-peer-"));
	const store = new DurableIrcStore(dir);
	try {
		store.enqueue({
			...input,
			peer: {
				kind: "question",
				source: "#source",
				rootId: "r",
				ancestry: ["#source"],
			},
		});
		store.claimNext();
		store.enqueue({ ...input, id: "in/answer", body: "collision" });
		assert.throws(() => store.complete(input.id, [output]), /collision/);
		assert.equal(store.listInbox()[0].state, "running");
		assert.equal(store.listOutbox().length, 0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("adds peer metadata column to existing delivery database without losing messages", () => {
	const dir = mkdtempSync(join(tmpdir(), "cuse-migration-"));
	const old = new DatabaseSync(join(dir, "irc-delivery.sqlite"));
	old.exec(`CREATE TABLE inbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 channel TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL);
 INSERT INTO inbox (id,channel,sender,body,created_at,state) VALUES ('old','#old','user','old message',1,'pending');`);
	old.close();
	const store = new DurableIrcStore(dir);
	try {
		assert.equal(store.listInbox()[0].body, "old message");
		assert.equal(store.listInbox()[0].peer, undefined);
		store.enqueue({
			...input,
			peer: {
				kind: "question",
				source: "#old",
				rootId: "root",
				ancestry: ["#old"],
			},
		});
		assert.equal(store.listInbox()[1].peer?.kind, "question");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
