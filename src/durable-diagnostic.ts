/** Only fixed classifications, never arbitrary message/stack/cause strings or tool arguments. */
function data(value:unknown,key:string):unknown {
 if(typeof value!=="object"||value===null)return undefined;
 try{return Object.getOwnPropertyDescriptor(value,key)?.value;}catch{return undefined;}
}
export function durableDiagnostic(error:unknown):string {
 const name=data(error,"name");const cause=data(error,"cause");
 if(name==="HarnessFault"&&data(cause,"message")==="Assistant response is aborted while durable control is running")return "provider-abort-control-mismatch";
 if(name==="HarnessFault")return "harness-fault";
 if(name==="AbortError"||name==="TimeoutError")return "request-interrupted";
 return "unclassified";
}

/**
 * Terminal provider failures are returned by the harness, not thrown. Its
 * assistant_error record keeps only an untrusted message, so classifications
 * are hints for private operators, never raw provider text or public guidance.
 * Only own data properties are inspected; getters/stringification are ignored.
 */
export function settledDiagnostic(result: unknown): string {
 const status = data(result, "status");
 if (status === "aborted") return "operation-aborted";
 if (status !== "failed") return "unclassified";
 const error = data(result, "error");
 const code = data(error, "code");
 if (code === "model_unavailable") return "configured-model-unavailable";
 if (code === "configured_tools_unavailable") return "configured-tools-unavailable";
 if (code !== "assistant_error") return "operation-failed";
 const message = data(error, "message");
 if (typeof message !== "string") return "provider-unclassified";
 // Bound processing and never include any part of the input in the result.
 const text = message.slice(0, 16_384).toLowerCase();
 if (/context_length_exceeded|maximum context length|context window|too many tokens|input is too long|prompt is too long/.test(text)) return "provider-context-limit";
 if (/insufficient_quota|quota exceeded|billing_hard_limit/.test(text)) return "provider-quota";
 // Codex rewrites several quota/rate-limit responses into this same sentence.
 if (/usage_limit_reached|usage_not_included|usage limit/.test(text)) return "provider-usage-limit";
 if (/provider is not configured|no api key for provider|oauth (?:refresh failed|auth derivation failed|refresh returned a token that expires too soon)|api key auth failed|credential store (?:read|modify) failed|failed to extract accountid from token|invalid_api_key|incorrect api key|invalid api key|invalid access token|token (?:has )?expired|unauthorized|authentication_error|\b401\b/.test(text)) return "provider-auth";
 if (/permission_denied|permission denied|access denied|forbidden|\b403\b/.test(text)) return "provider-permission";
 if (/model_not_found|model not found|model .*does not exist/.test(text)) return "provider-model-unavailable";
 if (/rate_limit_exceeded|rate limit|too many requests|\b429\b/.test(text)) return "provider-rate-limit";
 if (/invalid_request_error|invalid request|bad request|\b400\b/.test(text)) return "provider-request-invalid";
 if (/\b(?:500|502|503|504)\b|internal server error|service unavailable|overloaded/.test(text)) return "provider-server";
 if (/fetch failed|network error|connection (?:closed|reset|refused)|econnreset|econnrefused|etimedout|timed out|timeout/.test(text)) return "provider-transport";
 return "provider-unclassified";
}

/** A tool failure is a distinct boundary; arguments, output and names stay private. */
export function toolDiagnostic(name: unknown): string {
 if (typeof name === "string" && name.startsWith("weechat_")) return "native-tool-failed";
 if (["run_js", "get_artifact", "list_artifacts", "get_artifact_upload_url"].includes(name as string)) return "desktop-tool-failed";
 return "host-tool-failed";
}
