import { sessionKey } from "./session-key.ts";

/** Persisted session intent. `agent` follows the agent's managed desktop. */
export type DesktopBinding =
 | { kind: "none" }
 | { kind: "agent" }
 | { kind: "existing"; desktopId: string };

export interface DesktopPolicy {
 defaultBinding: DesktopBinding;
 overrides: Record<string, DesktopBinding>;
}

// IDs are opaque, case-sensitive path components, never URLs or channel names.
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function object(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate and detach a binding so a caller cannot mutate persisted intent. */
export function validateDesktopBinding(value: unknown): DesktopBinding {
 if (!object(value) || !Object.hasOwn(value, "kind")) throw new Error("Invalid cuse desktop binding");
 const fields = Object.keys(value);
 if ((value.kind === "none" || value.kind === "agent") && fields.length === 1) return { kind: value.kind };
 if (value.kind === "existing" && fields.length === 2 && Object.hasOwn(value, "desktopId")
  && typeof value.desktopId === "string" && DESKTOP_ID.exec(value.desktopId)?.[0] === value.desktopId) {
  return { kind: "existing", desktopId: value.desktopId };
 }
 throw new Error("Invalid cuse desktop binding");
}

function configuredBinding(value: unknown): DesktopBinding {
 if (value === "none") return { kind: "none" };
 if (value === "shared") return { kind: "agent" };
 if (object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "id")) {
  return validateDesktopBinding({ kind: "existing", desktopId: value.id });
 }
 throw new Error("Invalid cuse desktop policy binding");
}

/** Parse optional environment configuration without changing existing sessions. */
export function parseDesktopPolicy(defaultValue?: string, overridesJson?: string): DesktopPolicy {
 if (defaultValue !== undefined && defaultValue !== "none" && defaultValue !== "shared") {
  throw new Error("Invalid cuse default desktop policy: expected shared or none");
 }
 const defaultBinding = configuredBinding(defaultValue ?? "shared");
 const overrides: Record<string, DesktopBinding> = {};
 if (overridesJson === undefined) return { defaultBinding, overrides };
 let values: unknown;
 try { values = JSON.parse(overridesJson); }
 catch { throw new Error("Invalid cuse desktop overrides: expected a JSON array"); }
 if (!Array.isArray(values)) throw new Error("Invalid cuse desktop overrides: expected a JSON array");
 for (const value of values) {
  if (!object(value) || Object.keys(value).length !== 3
   || !Object.hasOwn(value, "agent") || !Object.hasOwn(value, "channel") || !Object.hasOwn(value, "desktop")
   || typeof value.agent !== "string" || typeof value.channel !== "string") {
   throw new Error("Invalid cuse desktop override: expected agent, channel, and desktop");
  }
  const key = sessionKey(value.agent, value.channel);
  if (Object.hasOwn(overrides, key)) throw new Error("Duplicate cuse desktop override: " + key);
  overrides[key] = configuredBinding(value.desktop);
 }
 return { defaultBinding, overrides };
}
