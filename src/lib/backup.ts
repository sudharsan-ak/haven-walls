import { invoke, isTauri } from "@tauri-apps/api/core";

export type BackupFrequency = "daily" | "weekly" | "interval";
export type BackupKind = "full" | "settings";

export interface BackupPreferences {
  enabled: boolean;
  destination: string;
  frequency: BackupFrequency;
  /** Local Windows clock, HH:MM */
  time: string;
  /** ISO day, Monday=1 to Sunday=7 */
  weekday: number;
  /** Used for interval scheduling (minimum one hour) */
  intervalMinutes: number;
  backupType: BackupKind;
  retention: number;
}
export interface BackupRecord {
  name: string;
  path: string;
  createdUnix: number;
  kind: BackupKind;
  bytes: number;
  fileCount: number;
}
export interface BackupStatus {
  preferences: BackupPreferences;
  nextDueUnix: number | null;
  lastSuccessUnix: number | null;
  lastError: string | null;
  history: BackupRecord[];
}
function desktop() {
  if (!isTauri()) throw new Error("Backups require Haven Walls for Windows.");
}
export async function getBackupStatus(): Promise<BackupStatus> {
  desktop();
  return invoke<BackupStatus>("get_backup_status");
}
export async function saveBackupPreferences(preferences: BackupPreferences): Promise<BackupStatus> {
  desktop();
  return invoke<BackupStatus>("save_backup_preferences", { preferences });
}
export async function backupNow(): Promise<BackupStatus> {
  desktop();
  return invoke<BackupStatus>("backup_now");
}
export async function chooseBackupFolder(): Promise<string | null> {
  desktop();
  return invoke<string | null>("choose_backup_folder");
}
