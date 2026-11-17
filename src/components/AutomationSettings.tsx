import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import RotationPanel from "./RotationPanel";
import BackgroundPanel from "./BackgroundPanel";
import { getRotationStatus, type RotationStatus } from "../lib/rotation";
import "./RotationPage.css";

function date(unix: number | null): string {
  return unix === null ? "Not scheduled" : new Date(unix * 1000).toLocaleString();
}
export default function AutomationSettings() {
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
      <RotationPanel onStatusChange={setStatus} />
      <BackgroundPanel />
      <p className="hws-settings-footnote">Library wallpapers are preferred. Only verified public-domain/CC0 images can enter the unattended reserve. Existing Windows wallpaper files and Library originals remain protected.</p>
    </div>
  );
}
