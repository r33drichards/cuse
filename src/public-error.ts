/** Only owned codes may supply public guidance; never stringify arbitrary failures. */
const GUIDANCE = {
 sessionBusy: "A turn is running; wait before manual compaction.",
 goalDelegation: "Goals cannot automate peer sends/questions or schedule mutations. Ask directly outside the goal; no additional model work was queued.",
 goalUnavailable: "Goals require CUSE_GOALS_ENABLED=true and CUSE_DURABLE_IRC=true.",
 goalInvalid: "Invalid goal, task/evidence, state or allowance. Use ,goal list/status. Start permits 1–200 steps; only one active goal per channel.",
 goalStopped: "Goal stopped, stale, expired or out of allowance. Inspect outcomes; only a direct human start can authorize further work.",
 goalRequestTimeout: "Goal request reached its bounded deadline. Tasks are saved; no automatic retry or allowance renewal occurred.",
 goalProviderAbort: "Goal provider stopped its request. Tasks are saved; no automatic retry or allowance renewal occurred.",
 goalRecovery: "A previous goal step needs recovery. Inspect unknown outcomes; after the stopped lane settles use ,goal recover ID inspected, then a new human start.",
 goalOrigin: "Goal updates require the matching active goal continuation. Peers, schedules and ordinary turns cannot start or update a goal.",
 goalDesktop: "Goals need this channel’s existing desktop. Send a normal prompt first; goals never create desktops.",
 desktopCreateRejected: "Replacement creation was rejected; no desktop was created. The original desktop and queue state were restored. Check permissions or available capacity, then retry.",
 desktopCreateUncertain: "Replacement creation may still be in progress. No matching desktop is visible yet. Wait and repeat the same confirmed command, or ask the private administrator to inspect it; no second create will be sent.",
 desktopOpening: "Desktop is still starting or temporarily unavailable. Your messages are saved; I will retry automatically.",
 scheduleUnavailable: "Scheduling requires CUSE_DURABLE_IRC=true and a running bot.",
 scheduleChannel: "Schedules belong to the current joined channel.",
 scheduleOrigin: "Scheduled turns and peer requests cannot create additional schedules. Ask directly in the channel.",
 scheduleInvalid: "Invalid schedule or unknown ID. Use ,schedule list; intervals must be at least 1m, cron uses five fields and an IANA timezone, one-shots must be in the future. Maximum 100 schedules per channel.",
 agentMessagingUnavailable: "Agent questions require CUSE_DURABLE_IRC=true so requests and replies survive restarts.",
 agentTarget: "Choose another joined channel from agent_list. No channel was joined automatically.",
 agentLoop: "This exchange already visited that agent or reached its four-agent limit. Return the information you have to the requester.",
 agentQuestion: "Agent questions must contain 1–8000 characters.",
 durableExtensions: "Durable IRC cannot load classic extensions yet. Keep classic mode until those extensions are migrated.",
 durableReload: "Durable resources reload requires a bot restart; classic extension loading is unavailable in this mode.",
 durableRequired: "This conversation uses durable storage. Enable CUSE_DURABLE_IRC to resume; the legacy history was not reopened.",
 tokenRequired: "COMPUTERUSE_API_TOKEN is required; ask the private administrator to configure it privately.",
 maxDesktops: "CUSE_MAX_DESKTOPS must be an integer from 1 to 10",
 httpsRequired: "Computer Use URLs must use HTTPS",
 remoteTool: "Computer Use tool failed; remote details were withheld. No automatic replay was attempted.",
 generic: "Operation failed. Ask the private administrator to check configuration; details were withheld.",
 forkUnavailable: "Disk snapshot fork is unavailable: Computer Use has no validated backend fork API yet. No desktop or conversation was copied.",
 modelSettings: "Explicit model settings require both provider and model; ask the private administrator to correct configuration. No fallback was selected.",
 modelMissing: "Configured model is absent from the installed catalog. Ask the private administrator to correct configuration. No fallback was selected.",
 codexAuth: "Authentication unavailable. Ask the private administrator to reauthenticate the ChatGPT account using pi login/setup. No fallback was selected.",
 providerAuth: "Authentication unavailable. Ask the private administrator to configure authentication for this provider. No fallback was selected.",
 joinedOnly: "irc_send requires an already joined IRC channel",
 recovery: "Remembered session identity could not be recovered. Ask the private administrator to reconcile it; no replacement was selected.",
 preparing: "Conversation fork is still being prepared; try again shortly",
 targetExists: "Target already exists or is being provisioned; choose a new channel",
 busy: "A source turn is running; wait before forking",
 quota: "Desktop limit reached; stop and ask the private administrator to reconcile owned desktops.",
 duplicate: "Multiple desktops match this channel; resolve them in Computer Use",
 joinRefused: "IRC join refused; ask the private administrator to check channel access.",
 joinLimit: "You are on too many channels; ,part a channel to free a slot",
} as const;
export type PublicErrorCode = keyof typeof GUIDANCE;
// Stable owned type brand also identifies byte-identical source/staged modules.
const OWNED_ERROR = Symbol.for("cuse.controlled-public-error.v1");
export class PublicError extends Error {
 readonly [OWNED_ERROR] = true;
 readonly publicCode: PublicErrorCode;
 constructor(code: PublicErrorCode) { super(GUIDANCE[code]); this.publicCode = code; }
}
export function publicError(error: unknown): string {
 // Even a known error's message/stack/cause may have been changed upstream.
 try {
  if (error instanceof PublicError || (typeof error === "object" && error !== null && (error as PublicError)[OWNED_ERROR] === true)) {
   const code = (error as PublicError).publicCode;
   if (Object.hasOwn(GUIDANCE, code)) return GUIDANCE[code];
  }
 } catch { /* Do not inspect hostile thrown objects. */ }
 return GUIDANCE.generic;
}

/** Only emitted by read-only desktop discovery, before a prompt can execute. */
const DESKTOP_OPEN_UNAVAILABLE = Symbol.for("cuse.desktop-open-unavailable.v1");
export class DesktopOpenUnavailableError extends PublicError {
 readonly [DESKTOP_OPEN_UNAVAILABLE] = true;
 constructor() { super("desktopOpening"); }
}
export function isDesktopOpenUnavailable(error: unknown): boolean {
 try { return typeof error === "object" && error !== null && (error as DesktopOpenUnavailableError)[DESKTOP_OPEN_UNAVAILABLE] === true; }
 catch { return false; }
}
