/** Only owned codes may supply public guidance; never stringify arbitrary failures. */
const GUIDANCE = {
 weechatIdentityLocked: "WeeChat identity is already locked. No second process was started; ask the private administrator to verify ownership before recovery. State was preserved.",
 desktopAbsent: "This session has no desktop. Desktop tools and lifecycle commands are unavailable; no desktop was provisioned.",
 desktopShared: "This desktop has an explicit shared reference. Session commands cannot stop, replace or delete it; ask the resource owner to coordinate its lifecycle.",
 desktopBusy: "Another session or desktop operation is using this shared desktop. Wait before changing its lifecycle.",
 desktopBindingImmutable: "The configured desktop binding conflicts with an existing session. State was preserved; use a new session or an explicitly reviewed migration.",
 nativeMsgidRequired: "WeeChat intake paused: a message has no lossless, unambiguous server msgid. No fallback ID or automatic replay was used.",
 nativeTimeRequired: "WeeChat intake paused: the approved history cutoff requires an unambiguous server-time tag. State was preserved.",
 nativeReplayRequiresDurable: "WeeChat restart replay requires CUSE_DURABLE_IRC=true so accepted inputs and commands have durable receipts.",
 nativeReplayMigration: "Legacy WeeChat receipts require a reviewed history cutoff before server-ID replay. State was preserved; choose CUSE_WEECHAT_HISTORY_AFTER only after reviewing the bounded history gap.",

 legacyDirectMessagesMigration: "Unfinished direct-message work requires operator inspection before channel-only WeeChat startup. State was preserved.",
 communicationTool: "WeeChat MCP tool failed; its outcome may be unknown. Inspect the affected service or ask the user before repeating an action. No automatic replay was attempted.",
 legacyPeersMigration: "Saved work from the removed peer mailbox requires operator inspection before startup. State was preserved; no peer work was replayed.",
 sessionBusy: "A turn is running; wait before manual compaction.",
 goalUnavailable: "Pi Goal requires CUSE_GOALS_ENABLED=true and CUSE_DURABLE_IRC=true.",
 legacyGoalsMigration: "Saved work from the removed goal engine requires operator inspection before this runtime can start. State was preserved; no old goal work was replayed.",
 desktopCreateRejected: "Replacement creation was rejected; no desktop was created. The original desktop and queue state were restored. Check permissions or available capacity, then retry.",
 desktopProfileMismatch: "The remembered desktop does not have the configured MCP profile. State was preserved; ask the private administrator to stop it, apply the profile, and resume it.",
 desktopCreateUncertain: "Replacement creation may still be in progress. No matching desktop is visible yet. Wait and repeat the same confirmed command, or ask the private administrator to inspect it; no second create will be sent.",
 desktopOpening: "Desktop is still starting or temporarily unavailable. Your messages are saved; I will retry automatically.",
 scheduleUnavailable: "Scheduling requires CUSE_DURABLE_IRC=true and a running bot.",
 scheduleChannel: "Schedules belong to the current joined channel.",
 scheduleOrigin: "Scheduled turns and peer requests cannot create additional schedules. Ask directly in the channel.",
 scheduleInvalid: "Invalid schedule or unknown ID. Use ,schedule list; intervals must be at least 1m, cron uses five fields and an IANA timezone, one-shots must be in the future. Maximum 100 schedules per channel.",
 durableExtensions: "Durable IRC cannot load classic extensions yet. Keep classic mode until those extensions are migrated.",
 durableReload: "Durable resources reload requires a bot restart; classic extension loading is unavailable in this mode.",
 durableRequired: "This conversation uses durable storage. Enable CUSE_DURABLE_IRC to resume; the legacy history was not reopened.",
 tokenRequired: "COMPUTERUSE_API_TOKEN is required; ask the private administrator to configure it privately.",
 maxDesktops: "CUSE_MAX_DESKTOPS must be an integer from 1 to 10",
 httpsRequired: "Computer Use URLs must use HTTPS",
 toolReported: "The tool reported an execution error. Inspect the script and current state, then correct the next step; do not repeat side effects without checking their outcome; remote details were withheld.",
 remoteTool: "Computer Use tool failed; its outcome may be unknown and remote details were withheld. Inspect the affected service or ask the user before repeating an action. No automatic replay was attempted.",
 generic: "Operation failed. Ask the private administrator to check configuration; details were withheld.",
 forkUnavailable: "Disk snapshot fork is unavailable: Computer Use has no validated backend fork API yet. No desktop or conversation was copied.",
 modelSettings: "Explicit model settings require both provider and model; ask the private administrator to correct configuration. No fallback was selected.",
 modelMissing: "Configured model is absent from the installed catalog. Ask the private administrator to correct configuration. No fallback was selected.",
 codexAuth: "Authentication unavailable. Ask the private administrator to reauthenticate the ChatGPT account using pi login/setup. No fallback was selected.",
 providerAuth: "Authentication unavailable. Ask the private administrator to configure authentication for this provider. No fallback was selected.",
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
