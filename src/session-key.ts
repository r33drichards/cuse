/**
 * A stable agent is identified by its original home channel, never its nick.
 * Home sessions keep the legacy channel key; only shared-room sessions need an
 * encoded pair. Delimiters cannot occur in either validated component.
 */
const CHANNEL = /^#[A-Za-z0-9_.-]{1,100}$/;
const LEGACY_CHANNEL = /^[#&][^\s,\x07]{1,63}$/;
const PAIR = /^session:v1:(#[A-Za-z0-9_.-]{1,100}):(#[A-Za-z0-9_.-]{1,100})$/;

function matches(pattern: RegExp, value: string): boolean {
 // Unlike `$` alone, this also rejects a trailing newline.
 return pattern.exec(value)?.[0] === value;
}

function pair(key: string): RegExpExecArray | undefined {
 const match = PAIR.exec(key);
 if (!match || match[0] !== key || match[1].toLowerCase() === match[2].toLowerCase()) return undefined;
 return match;
}

/** True only for a valid encoded, non-home session pair. */
export function isSessionKey(key: string): boolean { return pair(key) !== undefined; }

/** Decode an encoded pair or an ordinary legacy #/& home key. */
export function sessionAddress(key: string): { agent: string; channel: string } {
 const match = pair(key);
 if (match) return { agent: match[1].toLowerCase(), channel: match[2].toLowerCase() };
 if (matches(CHANNEL, key) || matches(LEGACY_CHANNEL, key)) {
  const home = key.toLowerCase();
  return { agent: home, channel: home };
 }
 throw new Error("Invalid cuse session key");
}

/** Build a canonical key without changing existing home-session identities. */
export function sessionKey(agent: string, channel: string): string {
 const home = agent.toLowerCase();
 const room = channel.toLowerCase();
 if (home === room) {
  if ((!matches(CHANNEL, agent) && !matches(LEGACY_CHANNEL, agent))
   || (!matches(CHANNEL, channel) && !matches(LEGACY_CHANNEL, channel))) throw new Error("Invalid cuse session address");
  return home;
 }
 if (!matches(CHANNEL, agent) || !matches(CHANNEL, channel)) throw new Error("Invalid cuse session address");
 return `session:v1:${home}:${room}`;
}
