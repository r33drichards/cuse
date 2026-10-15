import type { EventEmitter } from "node:events";
import type { WeeChatHandlers, WeeChatTransport } from "../../src/weechat.ts";

/** Test-only event fixture adapter. Production consumes native WeeChat MCP snapshots. */
export function fakeWeeChat(irc: EventEmitter & Record<string, any>): WeeChatTransport {
 let handlers: WeeChatHandlers;
 let sequence = 0;
 let closed = false;
 const wanted = new Set<string>();
 const joined = new Set<string>();
 const failures = new Map<string, unknown>();
 const didJoin = (channel: string) => {
  const key = channel.toLowerCase();
  if (joined.has(key)) return;
  wanted.add(key); joined.add(key); handlers.joined(key);
 };
 const didLeave = (channel: string) => {
  const key = channel.toLowerCase();
  joined.delete(key); handlers.disconnected(key);
 };
 const transport: WeeChatTransport = {
  setHandlers(next) { handlers = next; },
  nickFor: () => "cuse",
  communication: () => ({ tools: async () => [], call: async () => { throw Error("Unexpected native communication call"); } }),
  async join(channel) {
   wanted.add(channel); failures.delete(channel);
   await irc.join?.(channel);
   if (failures.has(channel)) throw failures.get(channel);
   didJoin(channel);
  },
  async part(channel) { await irc.part?.(channel); wanted.delete(channel); didLeave(channel); },
  async say(channel, text) { await irc.say?.(channel, text); },
  async queryTopic(channel) { await irc.raw?.("TOPIC", channel); },
  async setTopic(channel, topic) {
   failures.delete(channel);
   await irc.setTopic?.(channel, topic);
   if (failures.has(channel)) throw failures.get(channel);
  },
  async close() { closed = true; await irc.quit?.(); for (const channel of joined) didLeave(channel); },
 };
 irc.on("privmsg", event => {
  if (closed) return;
  const id = `test-weechat/${event.target}/${event.tags?.msgid ?? ++sequence}`;
  // Keep the synchronous acceptance boundary observable; async prompt completion
  // and failures are routed through the production transport handler contract.
  void handlers.message({ target: event.target, nick: event.nick, message: event.message, id }).catch(() => {});
 });
 irc.on("join", event => { if (!closed) didJoin(event.channel); });
 irc.on("part", event => { if (!closed) didLeave(event.channel); });
 irc.on("socket close", () => { for (const channel of joined) didLeave(channel); });
 irc.on("registered", () => {
  for (const channel of wanted) if (!joined.has(channel)) void transport.join(channel).catch(error => handlers.fault(channel, error));
 });
 irc.on("topic", event => handlers.topic(event.channel, event.topic));
 irc.on("irc error", event => {
  const channel = event.channel ?? "#control";
  const error = new Error(String(event.reason ?? event.error ?? "Synthetic transport failure"));
  failures.set(channel, error);
  handlers.fault(channel, error);
 });
 return transport;
}
