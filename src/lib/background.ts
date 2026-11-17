import { invoke, isTauri } from "@tauri-apps/api/core";

export interface BackgroundStatus {
  closeToTray: boolean;
  launchAtLogin: boolean;
  startupAvailable: boolean;
}
export async function getBackgroundStatus(): Promise<BackgroundStatus> {
  if (!isTauri()) throw new Error("Background settings are available in Haven Walls for Windows.");
  return invoke<BackgroundStatus>("get_background_status");
}
export async function saveBackgroundSettings(
  closeToTray: boolean, launchAtLogin: boolean,
): Promise<BackgroundStatus> {
  if (!isTauri()) throw new Error("Background settings require Haven Walls for Windows.");
  return invoke<BackgroundStatus>("save_background_settings", { closeToTray, launchAtLogin });
}
