import { invoke, isTauri } from "@tauri-apps/api/core";

export type ApiProvider = "serpapi" | "unsplash" | "tmdb";
export interface ApiCredentialStatus {
  serpapi: boolean;
  unsplash: boolean;
  tmdb: boolean;
}
function requireWindows(): void {
  if (!isTauri()) throw new Error("API credentials require Haven Walls for Windows.");
}

/** Only flags, never plaintext keys. */
export async function getApiCredentialStatus(): Promise<ApiCredentialStatus> {
  requireWindows();
  return invoke<ApiCredentialStatus>("get_api_credential_status");
}
/** Settings sends a new key once; Windows encrypts before SQLite storage. */
export async function saveApiCredential(
  provider: ApiProvider, value: string,
): Promise<ApiCredentialStatus> {
  requireWindows();
  return invoke<ApiCredentialStatus>("save_api_credential", { provider, value });
}
export async function removeApiCredential(provider: ApiProvider): Promise<ApiCredentialStatus> {
  requireWindows();
  return invoke<ApiCredentialStatus>("remove_api_credential", { provider });
}
