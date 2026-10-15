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
	const child = spawn(
		process.execPath,
		[
			"--import",
			new URL(
				"../.runtime/pi/node_modules/tsx/dist/loader.mjs",
				import.meta.url,
			).href,
			script,
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
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

test("new delivery databases have no peer mailbox column", () => {
 const dir = mkdtempSync(join(tmpdir(), "cuse-store-schema-"));
 const store = new DurableIrcStore(dir);
 try {
  const db = new DatabaseSync(join(dir, "irc-delivery.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA table_info(inbox)").all().some(column => column.name === "peer_json"), false); }
  finally { db.close(); }
  store.enqueue(input);
  store.claimNext();
  assert.equal(store.complete(input.id, [output]), undefined);
  assert.equal(store.listInbox().length, 1);
 } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
