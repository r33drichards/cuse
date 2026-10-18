import { settledDiagnostic } from "./durable-diagnostic.ts";

/** Fixed provider messages are the bridge to the harness's existing retry classifier.
 * Never wrap a whole operation in another retry loop: the harness checkpoints the
 * attempt budget and next-attempt time, and never replays completed tool calls.
 */
const PROVIDER_ERRORS: Readonly<Record<string, string>> = {
 "provider-context-limit": "context_length_exceeded",
 "provider-quota": "insufficient_quota",
 "provider-usage-limit": "usage_limit_reached",
 "provider-auth": "authentication_error",
 "provider-permission": "permission_denied",
 "provider-model-unavailable": "model_not_found",
 "provider-request-invalid": "invalid_request_error",
 "provider-rate-limit": "rate_limit_exceeded",
 "provider-server": "service unavailable",
 "provider-transport": "network error",
 "provider-cancelled": "request cancelled",
 "provider-state-invalid": "state integrity failure",
};

export function safeProviderError(message: unknown, contextOverflow: boolean): string {
 const category = settledDiagnostic({status: "failed", error: {code: "assistant_error", message}});
 // Preserve the harness's full provider-specific overflow matcher and its
 // throttling exclusions before discarding text. Diagnostics alone are not
 // an overflow decision. Explicit stop/access failures still fail closed.
 if (["provider-cancelled", "provider-state-invalid", "provider-auth", "provider-permission", "provider-quota", "provider-usage-limit"].includes(category)) return PROVIDER_ERRORS[category]!;
 if (contextOverflow) return PROVIDER_ERRORS["provider-context-limit"]!;
 if (category === "provider-context-limit") return "Unclassified provider failure";
 return PROVIDER_ERRORS[category] ?? "Unclassified provider failure";
}

/** Public settlement guidance is derived only from fixed categories. */
export function recoveryGuidance(result: unknown): string {
 switch (settledDiagnostic(result)) {
  case "operation-aborted":
  case "provider-cancelled":
   return "Paused: the operation was cancelled. No automatic retry will run.";
  case "provider-rate-limit":
  case "provider-server":
  case "provider-transport":
   return "Paused: temporary provider failure persisted after bounded retries. Ask to resume when the service is available.";
  case "provider-auth":
  case "provider-permission":
   return "Needs input: provider authentication or permission is unavailable. Ask the private administrator to restore access, then resume.";
  case "provider-quota":
  case "provider-usage-limit":
   return "Needs input: the provider usage allowance is exhausted. Resume after the allowance is restored.";
  case "provider-context-limit":
   return "Needs input: the conversation exceeds the provider context limit. Compact the conversation before resuming.";
  case "configured-model-unavailable":
  case "configured-tools-unavailable":
  case "provider-model-unavailable":
  case "provider-request-invalid":
   return "Needs input: the model or request configuration needs attention. Ask the private administrator to inspect it before resuming.";
  default:
   return "Paused: an unclassified failure needs inspection before resuming. Details were withheld; uncertain actions must be checked before retrying.";
 }
}
