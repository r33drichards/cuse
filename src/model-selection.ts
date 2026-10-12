import { PublicError } from "./public-error.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../core/model-runtime.ts";

type ExplicitModelRuntime = Pick<ModelRuntime, "getModel" | "getAvailable" | "getAuth">;

/** Prevent pi's default/resume resolver from switching providers after explicit selection fails. */
export async function requireExplicitModel(
 runtime: ExplicitModelRuntime, provider: string | undefined, modelId: string | undefined,
): Promise<Model<Api> | undefined> {
 if (!provider && !modelId) return undefined;
 if (!provider || !modelId) throw new PublicError("modelSettings");
 const model = runtime.getModel(provider, modelId);
 if (!model) throw new PublicError("modelMissing");
 try {
  const available = await runtime.getAvailable(provider);
  if (!available.some(candidate => candidate.id === modelId && candidate.provider === provider)) {
   throw new Error("Model authentication is not configured");
  }
  // Standard pi OAuth resolution refreshes credentials in host-side AuthStorage.
  // Never put credential details or raw provider error text into IRC messages.
  if (!await runtime.getAuth(model)) throw new Error("Model authentication is unavailable");
 } catch {
  throw new PublicError(provider === "openai-codex" ? "codexAuth" : "providerAuth");
 }
 return model;
}
