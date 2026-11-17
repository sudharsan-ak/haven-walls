/**
 * Process-local cache for the Windows-confirmed Dashboard image.
 * React unmounts Dashboard when navigating between sidebar destinations.
 * Keep a small number of decoded preview data URLs across those mounts,
 * but always re-check the active assignment against Windows on return.
 *
 * No disk writes, credentials, network calls or arbitrary file paths.
 */
import type {
  ActiveWallpaperPreview, CurrentWallpaper, WallpaperActivity,
} from "./windowsWallpaper";

const MAX_CACHED_PREVIEWS = 4;
const previews = new Map<string, ActiveWallpaperPreview>();
let lastActivity: WallpaperActivity | null = null;
let lastSelectedTarget = "";

function key(targetId: string, wallpaperId: string, appliedAt: string): string {
  return JSON.stringify([targetId, wallpaperId, appliedAt]);
}

function matches(preview: ActiveWallpaperPreview, current: CurrentWallpaper): boolean {
  return current.isCurrent &&
    preview.targetId === current.targetId &&
    preview.wallpaperId === current.wallpaperId &&
    preview.appliedAt === current.appliedAt;
}

/** A previously verified snapshot for instant paint, not a fresh OS claim. */
export function previousWallpaperActivity(): WallpaperActivity | null {
  return lastActivity;
}

export function cachedWallpaperPreview(current: CurrentWallpaper | null): ActiveWallpaperPreview | null {
  if (!current || !current.isCurrent) return null;
  return previews.get(key(current.targetId, current.wallpaperId, current.appliedAt)) ?? null;
}

export function lastDashboardTarget(): string {
  return lastSelectedTarget;
}
export function rememberDashboardTarget(targetId: string): void {
  lastSelectedTarget = targetId;
}

export function lastDashboardPreview(): ActiveWallpaperPreview | null {
  const current = lastActivity?.current.find((record) =>
    record.isCurrent && record.targetId === lastSelectedTarget
  ) ?? lastActivity?.current.find((record) => record.isCurrent) ?? null;
  return cachedWallpaperPreview(current);
}

/**
 * Called after the native OS status query succeeds. Invalidate previews for
 * externally changed wallpapers, changed assignments and applied timestamps.
 * A failed Windows check does not accidentally evict a good cached image.
 */
export function rememberVerifiedWallpaperActivity(activity: WallpaperActivity): void {
  lastActivity = activity;
  for (const [id, preview] of previews) {
    if (!activity.current.some((record) => matches(preview, record))) {
      previews.delete(id);
    }
  }
}

/** Cache only a successfully fetched, Windows-confirmed native thumbnail. */
export function rememberWallpaperPreview(preview: ActiveWallpaperPreview): void {
  const id = key(preview.targetId, preview.wallpaperId, preview.appliedAt);
  previews.delete(id);
  previews.set(id, preview);
  while (previews.size > MAX_CACHED_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    previews.delete(oldest);
  }
}

/** A confirmed local/automatic wallpaper apply invalidates prior assignments. */
export function invalidateDashboardWallpaperCache(): void {
  lastActivity = null;
  previews.clear();
}
