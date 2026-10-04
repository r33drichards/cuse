import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";

type ExplicitModelRuntime = Pick<ModelRuntime, "getModel" | "getAvailable" | "getAuth">;

/** Prevent pi's default/resume resolver from switching providers after explicit selection fails. */
export async function requireExplicitModel(
 runtime: ExplicitModelRuntime, provider: string | undefined, modelId: string | undefined,
): Promise<Model<Api> | undefined> {
 if (!provider && !modelId) return undefined;
 if (!provider || !modelId) throw new Error("Explicit model settings require both provider and model; ask the private administrator to correct configuration. No fallback was selected.");
 const guidance = provider === "openai-codex"
  ? "Ask the private administrator to reauthenticate the ChatGPT account using pi login/setup."
  : "Ask the private administrator to configure authentication for this provider.";
 const model = runtime.getModel(provider, modelId);
 if (!model) throw new Error(
  "Configured model " + provider + "/" + modelId + " is absent from the installed catalog. Ask the private administrator to correct configuration. No fallback was selected.");
 try {
  const available = await runtime.getAvailable(provider);
  if (!available.some(candidate => candidate.id === modelId && candidate.provider === provider)) {
   throw new Error("Model authentication is not configured");
  }
  // Standard pi OAuth resolution refreshes credentials in host-side AuthStorage.
  // Never put credential details or raw provider error text into IRC messages.
  if (!await runtime.getAuth(model)) throw new Error("Model authentication is unavailable");
 } catch {
  throw new Error("Authentication unavailable for " + provider + "/" + modelId + ". " + guidance + " No fallback was selected.");
 }
 return model;
}
