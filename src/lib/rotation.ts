import { invoke, isTauri } from "@tauri-apps/api/core";
import { invalidateDashboardWallpaperCache } from "./dashboardPreviewCache";
import type { WallpaperApplyResult } from "./windowsWallpaper";

export type DiscoveryTopic =
  | "nature" | "space" | "cities" | "mountains"
  | "oceans" | "wildlife" | "architecture" | "abstract";

export interface RotationPreferences {
  enabled: boolean;
  paused: boolean;
  pinned: boolean;
  intervalMinutes: number;
  favoritesOnly: boolean;
  cooldownDays: number;
  scheduleMode: "interval" | "daily";
  dailyTime: string;
  discoveryEnabled: boolean;
  discoveryTopics: DiscoveryTopic[];
}
export interface RotationStatus {
  preferences: RotationPreferences;
  nextDueUnix: number | null;
  lastSuccessUnix: number | null;
  lastWallpaperId: string | null;
  lastError: string | null;
  eligibleCount: number;
  reserveCount: number;
  nextDiscoveryUnix: number | null;
  lastDiscoveryError: string | null;
  lastDiscoveryTopic: string | null;
  lastDiscoveryUnix: number | null;
  lastDiscoveryOutcome: "saved" | "no_match" | "error" | null;
}
function desktopOnly(): void {
  if (!isTauri()) throw new Error("Wallpaper rotation requires Haven Walls for Windows.");
}
export async function getRotationStatus(): Promise<RotationStatus> {
  desktopOnly();
  return invoke<RotationStatus>("get_rotation_status");
}
export async function saveRotationPreferences(preferences: RotationPreferences): Promise<RotationStatus> {
  desktopOnly();
  return invoke<RotationStatus>("save_rotation_preferences", { preferences });
}
export async function rotateNextWallpaper(): Promise<WallpaperApplyResult> {
  desktopOnly();
  const applied = await invoke<WallpaperApplyResult>("rotation_next");
  invalidateDashboardWallpaperCache();
  return applied;
}
