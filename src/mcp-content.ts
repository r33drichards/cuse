export type McpModelContent = {type:"text";text:string} | {type:"image";data:string;mimeType:string};

/** Keep screenshots in model context; never serialize image base64 into IRC text. */
export function modelContent(result: {content?:unknown[];structuredContent?:unknown}): McpModelContent[] {
 const content: McpModelContent[] = [];
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
