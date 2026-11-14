/** Display preferences shared with the next wallpaper-application milestone.
 * Caption and visual credit overlay do not modify the desktop in PR #2.
 */
export interface WallpaperDisplayPrefs {
  showPhotoCredit: boolean;
  showCaption: boolean;
}
export const DEFAULT_DISPLAY_PREFS: WallpaperDisplayPrefs = {
  showPhotoCredit: true,
  showCaption: false,
};
const KEY = "haven-walls.wallpaper-display-prefs.v1";

export function loadWallpaperDisplayPrefs(): WallpaperDisplayPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_DISPLAY_PREFS };
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return { ...DEFAULT_DISPLAY_PREFS };
    const obj = candidate as Record<string, unknown>;
    return {
      showPhotoCredit: typeof obj.showPhotoCredit === "boolean"
        ? obj.showPhotoCredit : DEFAULT_DISPLAY_PREFS.showPhotoCredit,
      showCaption: typeof obj.showCaption === "boolean"
        ? obj.showCaption : DEFAULT_DISPLAY_PREFS.showCaption,
    };
  } catch {
    return { ...DEFAULT_DISPLAY_PREFS };
  }
}
export function saveWallpaperDisplayPrefs(prefs: WallpaperDisplayPrefs): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
