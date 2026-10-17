import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSafePngImages, OMITTED_PNG_TEXT } from "../.runtime/pi/packages/coding-agent/src/cuse/provider-images.ts";
import { DurableChannelSession } from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import { createModels, fauxProvider, fauxAssistantMessage, type Message, type ImageContent } from "../.runtime/pi/packages/ai/src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../.runtime/pi/packages/agent/src/index.ts";
import { SettingsManager } from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import { DefaultResourceLoader } from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

function chunk(type: string, data: Buffer): Buffer {
 const result = Buffer.alloc(data.length + 12);
 result.writeUInt32BE(data.length); result.write(type, 4, 4, "ascii"); data.copy(result, 8);
 result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
 return result;
}
function png(width = 1, height = 1, options: { split?: boolean; ancillary?: boolean; interlaced?: boolean } = {}): Buffer {
 const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[12] = options.interlaced ? 1 : 0;
 // One pixel is also a valid Adam7 image; larger fixtures are non-interlaced.
 const pixels = Buffer.alloc((width * 3 + 1) * height, 127);
 for (let row = 0; row < height; row++) pixels[row * (width * 3 + 1)] = 0;
 const compressed = deflateSync(pixels, { level: 0 });
 const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
 if (options.ancillary) parts.push(chunk("tEXt", Buffer.from("Comment\0Synthetic fixture")));
 if (options.split) { const mid = Math.floor(compressed.length / 2); parts.push(chunk("IDAT", compressed.subarray(0, mid)), chunk("IDAT", compressed.subarray(mid))); }
 else parts.push(chunk("IDAT", compressed));
 parts.push(chunk("IEND", Buffer.alloc(0))); return Buffer.concat(parts);
}
const image = (bytes: Buffer, mimeType = "image/png"): ImageContent => ({ type: "image", mimeType, data: bytes.toString("base64") });
const user = (block: ImageContent): Message => ({ role: "user", content: [block], timestamp: 1 });
function freezeDeep<T>(value: T): T { if (value && typeof value === "object") { for (const item of Object.values(value)) freezeDeep(item); Object.freeze(value); } return value; }
function replaced(block: ImageContent): void { assert.deepEqual(withSafePngImages([user(block)])[0].content, [{ type: "text", text: OMITTED_PNG_TEXT }]); }

test("valid PNGs remain byte-for-byte and reference-identical, including beyond 64 KiB base64", () => {
 const large = image(png(256, 128)); assert.ok(large.data.length > 65_536);
 for (const block of [image(png()), large, image(png(1, 1, { split: true, ancillary: true, interlaced: true }))]) {
  const messages = freezeDeep([user(block)]); assert.equal(withSafePngImages(messages), messages); assert.equal((messages[0].content as ImageContent[])[0], block);
 }
});
test("valid optional base64 padding and ASCII whitespace are not normalized or replaced", () => {
 const original = image(png(1, 2));
 assert.match(original.data, /=+$/);
 const unpadded = original.data.replace(/=+$/, ""); assert.notEqual(unpadded, original.data);
 for (const data of [original.data, unpadded, original.data.match(/.{1,16}/g)!.join(" \t\n")]) {
  const messages = freezeDeep([user({ ...original, data })]); assert.equal(withSafePngImages(messages), messages);
 }
});
test("non-PNG blocks, string content and assistant messages are untouched", () => {
 const messages = freezeDeep<Message[]>([user(image(Buffer.from("not decoded here"), "image/jpeg")), user(image(Buffer.from("GIF89a"), "image/gif")), user(image(Buffer.from("RIFF"), "image/webp")), { role: "user", content: "Text", timestamp: 2 }, fauxAssistantMessage("Answer")]);
 assert.equal(withSafePngImages(messages), messages);
});
test("incomplete PNG signature, chunk header/body/CRC or IEND is omitted only from the request", () => {
 const bytes = png();
 for (const end of [0, 4, 8, 10, 20, 31, bytes.length - 1, bytes.length - 12]) replaced(image(bytes.subarray(0, end)));
});
test("malformed PNG checksum, header, base64 alphabet and chunk lengths are rejected", () => {
 const badCrc = Buffer.from(png()); badCrc[29] ^= 1; replaced(image(badCrc));
 const badLength = Buffer.from(png()); badLength.writeUInt32BE(0xffffffff, 33); replaced(image(badLength));
 const zeroWidth = Buffer.alloc(13); zeroWidth[8] = 8; zeroWidth[9] = 2; zeroWidth.writeUInt32BE(1, 4);
 replaced(image(Buffer.concat([png().subarray(0, 8), chunk("IHDR", zeroWidth), chunk("IDAT", Buffer.from([0])), chunk("IEND", Buffer.alloc(0))])));
 for (const data of ["!!!", "A", "AA=", "=AAA", "A==="]) replaced({ type: "image", mimeType: "image/png", data });
 replaced(image(Buffer.concat([png(), Buffer.from([0])])));
 replaced(image(Buffer.concat([png().subarray(0, 33), chunk("IHDR", png().subarray(16, 29)), png().subarray(33)])));
 replaced(image(Buffer.concat([png().subarray(0, 33), chunk("IEND", Buffer.alloc(0))])));
});
test("a synthetic 49,152-byte truncated PNG with 65,536 base64 characters is replaced", () => {
 const complete = png(256, 128); assert.ok(complete.length > 49_152);
 const truncated = image(complete.subarray(0, 49_152)); assert.equal(truncated.data.length, 65_536); replaced(truncated);
});
test("container checking is not pixel decoding, and work-limit inputs pass through", () => {
 const containerOnly = image(Buffer.concat([png().subarray(0, 33), chunk("IDAT", Buffer.from("not zlib data")), chunk("IEND", Buffer.alloc(0))]));
 for (const block of [containerOnly, { type: "image" as const, mimeType: "image/png", data: "A".repeat(32 * 1024 * 1024 + 1) }]) {
  const messages = [user(block)]; assert.equal(withSafePngImages(messages), messages);
 }
});
test("copy-on-write preserves tool pairing, result flags, text and deeply frozen originals", () => {
 const good = image(png()), bad = image(png().subarray(0, 20)), text = { type: "text" as const, text: "Companion text" };
 const call = fauxAssistantMessage([{ type: "toolCall", id: "paired", name: "weechat_context", arguments: {} }], { stopReason: "toolUse" });
 const result: Message = { role: "toolResult", toolCallId: "paired", toolName: "weechat_context", content: [text, bad, good], isError: true, timestamp: 123, details: { kept: true } };
 const messages = freezeDeep<Message[]>([user(good), call, result]); const original = JSON.stringify(messages);
 const copied = withSafePngImages(messages);
 assert.notEqual(copied, messages); assert.equal(copied[0], messages[0]); assert.equal(copied[1], call); assert.notEqual(copied[2], result);
 assert.deepEqual(copied[2], { ...result, content: [text, { type: "text", text: OMITTED_PNG_TEXT }, good] });
 assert.equal((copied[2].content as any[])[0], text); assert.equal((copied[2].content as any[])[2], good);
 assert.equal(JSON.stringify(messages), original); assert.equal(withSafePngImages(copied), copied);
});
test("real durable request copies omit a malformed image while original history survives reopen", async t => {
 const dir = mkdtempSync(join(tmpdir(), "cuse-png-"));
 const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
 const runtime = Object.create(models); runtime.getAvailable = async () => [faux.getModel()];
 const good = image(png()), bad = image(png().subarray(0, 20));
 const content = freezeDeep([{ type: "text" as const, text: "Companion text" }, bad, good]);
 const deps: any = {
  cwd: dir, agentDir: dir, sessionDir: join(dir, "sessions"), modelRuntime: runtime, delegate: {}, log: () => {},
  desktop: { tools: async () => { throw Error("No desktop discovery expected"); } },
  communication: { tools: async () => [{ name: "weechat_context", inputSchema: { type: "object", properties: {} } }], call: async () => ({ content }) },
  createResources: async () => {
   const settingsManager = SettingsManager.inMemory({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id });
   const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
   await resourceLoader.reload(); return { settingsManager, resourceLoader };
  },
 };
 let session: DurableChannelSession | undefined;
 t.after(async () => { await session?.close(); rmSync(dir, { recursive: true, force: true }); });
 const checkRequest = (context: any) => {
  const result = context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "paired");
  assert.ok(result); assert.equal(result.toolName, "weechat_context"); assert.equal(result.isError, false);
  assert.deepEqual(result.content, [content[0], { type: "text", text: OMITTED_PNG_TEXT }, good]);
  assert.ok(context.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.type === "toolCall" && b.id === "paired")));
  return fauxAssistantMessage("Safe request");
 };
 faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "paired", name: "weechat_context", arguments: {} }], { stopReason: "toolUse" }), checkRequest]);
 session = await DurableChannelSession.open("#test", deps);
 assert.equal((await session.promptDurable("first", "Read context")).text, "Safe request");
 const entries = await session.lane.findEntries({ type: "message" }, ctx);
 const stored = entries.find(e => e.type === "message" && e.message.role === "toolResult");
 assert.ok(stored?.type === "message" && stored.message.role === "toolResult"); assert.deepEqual(stored.message.content, content);
 const file = session.sessionFile, id = session.sessionId, model = session.modelLabel(), thinking = session.thinkingLevel(), active = await session.lane.getActiveTools(ctx);
 await session.close(); session = await DurableChannelSession.open("#test", deps, { sessionFile: file });
 assert.equal(session.sessionId, id); assert.deepEqual(await session.lane.findEntries({ type: "message" }, ctx), entries);
 faux.setResponses([checkRequest]); assert.equal((await session.promptDurable("second", "Continue")).text, "Safe request");
 assert.deepEqual((await session.lane.findEntries({ type: "message" }, ctx)).find(e => e.id === stored.id), stored);
 assert.equal(session.modelLabel(), model); assert.equal(session.thinkingLevel(), thinking); assert.deepEqual(await session.lane.getActiveTools(ctx), active);
 assert.deepEqual(content, [content[0], bad, good]); assert.equal(faux.state.callCount, 3);
});
