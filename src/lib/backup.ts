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
  recoveryRetention: number;
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
  recoveryFolder: string;
  recoveryCount: number;
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
export async function openRecoveryFolder(): Promise<void> {
  desktop();
  return invoke<void>("open_recovery_folder");
}

/** A preview is deliberately read-only. It verifies hashes and the source DB. */
export interface RestorePreview {
  backupPath: string;
  manifestHash: string;
  createdUnix: number;
  kind: BackupKind;
  bytes: number;
  imageCount: number;
  categoryCount: number;
  collectionCount: number;
  interestCount: number;
  warning: string;
}
export type RestoreMode = "merge" | "replace";
export interface RestoreResult {
  mode: RestoreMode;
  kind: BackupKind;
  restoredImages: number;
  recoveryPath: string;
  notice: string;
}
export async function previewBackupRestore(path: string): Promise<RestorePreview> {
  desktop();
  return invoke<RestorePreview>("preview_backup_restore", { path });
}
export async function restoreBackup(
  preview: RestorePreview, mode: RestoreMode,
): Promise<RestoreResult> {
  desktop();
  return invoke<RestoreResult>("restore_backup", {
    path: preview.backupPath, manifestHash: preview.manifestHash, mode,
  });
}
