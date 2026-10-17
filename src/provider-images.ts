import { crc32 } from "node:zlib";
import type { Message } from "@earendil-works/pi-ai";

export const OMITTED_PNG_TEXT =
 "[Stored PNG image omitted from this request because its data is incomplete or malformed. Original session data is unchanged.]";

// Bound request-copy validation work. Larger inputs are unvalidated/pass-through,
// never labeled corrupt merely for exceeding this limit.
const MAX_ENCODED_PNG_CHARS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Container integrity only: this does not inflate IDAT or decode pixels. */
function malformedPng(data: string): boolean {
 if (data.length > MAX_ENCODED_PNG_CHARS) return false;
 // Accept omitted padding and ASCII whitespace without rewriting valid data.
 const encoded = data.replace(/[\t\n\f\r ]/g, "");
 if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1
  || (encoded.includes("=") && encoded.length % 4 !== 0)) return true;
 const bytes = Buffer.from(encoded, "base64");
 if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return true;
 let offset = 8, sawHeader = false, sawImageData = false;
 while (offset < bytes.length) {
  if (bytes.length - offset < 12) return true;
  const length = bytes.readUInt32BE(offset);
  if (length > bytes.length - offset - 12) return true;
  const end = offset + 8 + length;
  if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) return true;
  const type = bytes.toString("ascii", offset + 4, offset + 8);
  if (!sawHeader) {
   if (type !== "IHDR" || length !== 13) return true;
   const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
   if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return true;
   sawHeader = true;
  } else if (type === "IHDR") return true;
  if (type === "IDAT") sawImageData = true;
  if (type === "IEND") return length !== 0 || !sawImageData || end + 4 !== bytes.length;
  offset = end + 4;
 }
 return true; // Missing complete IEND, including cut-off header/body/CRC.
}

export function withSafePngImages(messages: Message[]): Message[] {
 let output: Message[] | undefined;
 for (let index = 0; index < messages.length; index++) {
  const message = messages[index]!;
  if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) continue;
  let changed = false;
  const content = message.content.map(block => {
   if (block.type !== "image" || block.mimeType !== "image/png" || !malformedPng(block.data)) return block;
   changed = true;
   return { type: "text" as const, text: OMITTED_PNG_TEXT };
  });
  if (changed) {
   output ??= messages.slice();
   output[index] = { ...message, content };
  }
 }
 return output ?? messages;
}
