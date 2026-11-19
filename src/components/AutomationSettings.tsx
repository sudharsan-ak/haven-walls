import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import RotationPanel from "./RotationPanel";
import BackgroundPanel from "./BackgroundPanel";
import { getRotationStatus, type RotationStatus } from "../lib/rotation";
import "./RotationPage.css";

function date(unix: number | null): string {
  return unix === null ? "Not scheduled" : new Date(unix * 1000).toLocaleString();
}
interface Props {
  onBrowseWallpapers: () => void;
  onOpenLibrary: () => void;
  onOpenCollections: () => void;
}
export default function AutomationSettings({
  onBrowseWallpapers, onOpenLibrary, onOpenCollections,
}: Props) {
  const [status, setStatus] = useState<RotationStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getRotationStatus().then((value) => {
        if (active) setStatus(value);
      }).catch(() => { /* Child controls surface configuration errors. */ });
    };
    refresh();
    const interval = window.setInterval(refresh, 15000);
    let unlisten: (() => void) | null = null;
    void listen("rotation:applied", refresh).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => {});
    return () => { active = false; window.clearInterval(interval); unlisten?.(); };
  }, []);
  const prefs = status?.preferences;
  const rotationState = !prefs ? "Checking…" : !prefs.enabled ? "Off" :
    prefs.pinned ? "Pinned" : prefs.paused ? "Paused" : "Running";
  return (
    <div className="hws-automation">
      <p className="hws-settings-intro">Configure automatic wallpaper changes, approved discovery topics, and how Haven Walls operates in the background. All changes are saved locally.</p>
      <div className="hwr-summary-grid">
        <div><small>Rotation</small><strong>{rotationState}</strong></div>
        <div><small>Next change</small><strong>{date(status?.nextDueUnix ?? null)}</strong></div>
        <div><small>Available images</small><strong>{status?.eligibleCount ?? "—"}</strong></div>
        <div><small>Offline reserve</small><strong>{status ? String(status.reserveCount) + " / 10" : "—"}</strong></div>
      </div>
      {status && status.eligibleCount === 0 && (
        <div className="hwr-empty-pool" role="status">
          <div>
            <strong>{status.preferences.rotationScope === "collections"
              ? "No wallpapers in the selected collections are ready to rotate"
              : status.preferences.favoritesOnly
                ? "No favorite wallpapers ready to rotate"
                : "Your rotation pool is empty"}</strong>
            <p>{status.preferences.rotationScope === "collections"
              ? "Add eligible landscape wallpapers to your chosen collections or change the rotation selection. Haven Walls won't use unrelated reserve images."
              : status.preferences.favoritesOnly
                ? "Favorite a saved wallpaper in Library, or switch off Favorites only."
                : "Save a wallpaper in Library or enable approved discovery to build an offline reserve."}</p>
          </div>
          <div className="hwr-empty-pool-actions">
            <button type="button" onClick={onOpenLibrary}>Open Library</button>
            <button type="button" onClick={onBrowseWallpapers}>Browse Gallery</button>
          </div>
        </div>
      )}
      <RotationPanel onStatusChange={setStatus} onOpenCollections={onOpenCollections} />
      <BackgroundPanel />
      <p className="hws-settings-footnote">Library wallpapers are preferred. Only verified public-domain/CC0 images can enter the unattended reserve. Existing Windows wallpaper files and Library originals remain protected.</p>
    </div>
  );
}
