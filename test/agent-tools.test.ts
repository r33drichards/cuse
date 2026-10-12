import test from "node:test";
import assert from "node:assert/strict";
import {
	createDelegationTools,
	createDurableAgentTools,
	createDesktopTools,
} from "../.runtime/pi/packages/coding-agent/src/cuse/tools.ts";
import { guardTool } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";

test("classic questions bind sender and use session-scoped stable call identity", async () => {
	const requests: any[] = [];
	const delegate = {
		send: async () => {},
		listAgents: (room: string) => {
			assert.equal(room, "#source");
			return [{ channel: "#peer", busy: true }];
		},
		ask: async (r: any) => {
			requests.push(r);
			return {
				requestId: r.requestId,
				channel: r.channel,
				status: "queued" as const,
			};
		},
	};
	const tools = createDelegationTools(delegate, "#source", "session-a");
	const ask = tools.find((t) => t.name === "agent_ask")!;
	const execute = ask.execute as any;
	const input = {
		room: "#forged",
		requestId: "forged",
		channel: "#peer",
		question: "What did you find?",
	};
	await execute("call-1", input);
	await execute("call-1", input);
	assert.deepEqual(requests, [
		{
			room: "#source",
			requestId: "session-a:call-1",
			channel: "#peer",
			question: "What did you find?",
		},
		{
			room: "#source",
			requestId: "session-a:call-1",
			channel: "#peer",
			question: "What did you find?",
		},
	]);
	const listed = await (
		tools.find((t) => t.name === "agent_list")!.execute as any
	)("list", {});
	assert.deepEqual(JSON.parse(listed.content[0].text), [
		{ channel: "#peer", busy: true },
	]);
});
test("durable mailbox replays use invocation identity, while desktop execution never replays", async () => {
	const requests: any[] = [];
	const tools = createDurableAgentTools(
		{
			send: async () => {},
			ask: async (r) => {
				requests.push(r);
				return { ...r, status: "queued" };
			},
		},
		"#source",
		"session-a",
	);
	const ask = tools.find((t) => t.name === "agent_ask")!;
	assert.equal(ask.replay, "safe");
	assert.equal(tools.find((t) => t.name === "agent_list")!.replay, "safe");
	const invoke = ask.execute as any;
	await invoke(
		"different-call-id",
		{ channel: "#peer", question: "status" },
		() => {},
		undefined,
		{ invocationId: "stable-invocation" },
	);
	await invoke(
		"another-call-id",
		{ channel: "#peer", question: "status" },
		() => {},
		undefined,
		{ invocationId: "stable-invocation" },
	);
	assert.equal(requests[0].requestId, "session-a:stable-invocation");
	assert.deepEqual(requests[0], requests[1]);
	assert.equal(
		guardTool({
			name: "run_js",
			label: "run_js",
			description: "remote",
			parameters: {} as any,
			execute: async () => ({ content: [], details: {} }),
		}).replay,
		"never",
	);
	const desktop = await createDesktopTools({
		tools: async () => [{ name: "run_js", inputSchema: { type: "object" } }],
	} as any);
	assert.deepEqual(
		desktop.map((t) => t.name),
		["run_js"],
	);
});
test("unavailable mailbox fails clearly without posting via irc_send", async () => {
	const tools = createDelegationTools(
		{
			send: async () => {
				throw Error("must not post");
			},
		},
		"#source",
	);
	for (const name of ["agent_list", "agent_ask"]) {
		await assert.rejects(
			(tools.find((t) => t.name === name)!.execute as any)("id", {
				channel: "#peer",
				question: "hello",
			}),
			(error: any) => error.publicCode === "agentMessagingUnavailable",
		);
	}
});

test("host desktop controls bind room, reject extra privileges and receipt mutations", async () => {
 const calls:string[]=[];
 const tool=createDurableAgentTools({send:async()=>{},desktopControl:async(room,action)=>{calls.push(`${room}/${action}`);return{state:action};}},"#own","sid").find(t=>t.name==="desktop_control")!;
 const memo=new Map();
 const invocation={getMemo:async(k:string)=>memo.get(k),setMemo:async(k:string,v:unknown)=>{memo.set(k,v);}};
 const execute=(params:unknown)=> (tool.execute as any)("id",params,undefined,undefined,invocation);
 await assert.rejects(execute({action:"delete"}));
 await assert.rejects(execute({action:"stop",room:"#other"}));
 const first=await execute({action:"stop"});
 assert.deepEqual(await execute({action:"stop"}),first);
 assert.deepEqual(calls,["#own/stop"]);
 memo.delete("desktop.result");
 assert.equal((await execute({action:"stop"})).details.ambiguous,true);
 assert.equal(calls.length,1);
});
