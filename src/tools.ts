import { PublicError } from "./public-error.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../core/extensions/index.ts";
import type { DesktopMcp, RemoteResult } from "./computer-use.ts";

export interface ChannelDelegate {
 send(request: { room: string; channel: string; text: string }): Promise<void>;
}

/** Keep screenshots in model context; never serialize image base64 into IRC text. */
export function modelContent(result: RemoteResult): (TextContent | ImageContent)[] {
 const content: (TextContent | ImageContent)[] = [];
 for (const value of result.content ?? []) {
  if (typeof value !== "object" || value === null) continue;
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
  else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
   content.push({ type: "image", data: block.data, mimeType: block.mimeType });
  } else content.push({ type: "text", text: "[Unsupported MCP content: " + String(block.type) + "]" });
 }
 if (!content.length) content.push({ type: "text", text: result.structuredContent === undefined ? "(no output)" : JSON.stringify(result.structuredContent) });
 return content;
}

const ALLOWED_TOOLS = new Set(["run_js", "get_artifact", "list_artifacts", "get_artifact_upload_url"]);
export async function createDesktopTools(desktop: DesktopMcp): Promise<ToolDefinition[]> {
 const remote = await desktop.tools();
 if (!remote.some(tool => tool.name === "run_js")) throw new Error("Desktop does not expose run_js");
 return remote.filter(tool => ALLOWED_TOOLS.has(tool.name)).map(tool => defineTool({
  name: tool.name, label: tool.name,
  description: tool.description ?? "Call " + tool.name + " on this channel's Computer Use desktop.",
  promptSnippet: "Use this channel's isolated desktop, browser, shell, files and artifacts.",
  promptGuidelines: ["All execution belongs to this IRC channel's desktop. Host filesystem tools are unavailable. JavaScript variables do not persist between calls; save reusable code and notes under /data/."],
  parameters: tool.inputSchema as TSchema,
  executionMode: "sequential",
  async execute(_id, params, signal) {
   // One call only. SDK turns this controlled exception into isError=true.
   // Never place arbitrary remote failures (including structured/image data) in model context.
   let result: RemoteResult;
   try { result = await desktop.call(tool.name, params, signal); }
   catch { throw new PublicError("remoteTool"); }
   if (result.isError) throw new PublicError("remoteTool");
   return { content: modelContent(result), details: { remoteError: false } };
  },
 })) as ToolDefinition[];
}

export function createDelegationTools(delegate: ChannelDelegate, room: string): ToolDefinition[] {
 return [defineTool({
  name: "irc_send", label: "irc_send",
  description: "Post to another channel cuse has already joined, only when the user explicitly requests it. Mentioning cuse prompts that channel's independent agent. No files or browser state are shared.",
  parameters: Type.Object({ channel: Type.String(), text: Type.String() }),
  async execute(_id, params) {
   await delegate.send({ room, ...params });
   return { content: [{ type: "text" as const, text: "Sent to " + params.channel }], details: undefined };
  },
 })] as ToolDefinition[];
}
