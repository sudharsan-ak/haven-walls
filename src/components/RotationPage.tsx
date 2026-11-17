import { useEffect, useState } from "react";
import RotationPanel from "./RotationPanel";
import BackgroundPanel from "./BackgroundPanel";
import { getRotationStatus, type RotationStatus } from "../lib/rotation";
import "./RotationPage.css";

function date(unix: number | null): string {
  return unix == null ? "Not scheduled" : new Date(unix * 1000).toLocaleString();
}
export default function RotationPage() {
  const [status, setStatus] = useState<RotationStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getRotationStatus().then((value) => { if (active) setStatus(value); }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return (
    <div className="hwr-schedule-page">
      <div className="eyebrow">Haven Walls / Automation</div>
      <h1>Rotation schedule</h1>
      <p className="subheading">Choose when wallpapers change, where new wallpapers come from, and what happens when Haven Walls is minimized or closed.</p>
      <div className="hwr-summary-grid">
        <div><small>Rotation</small><strong>{!status ? "Checking…" :
          !status.preferences.enabled ? "Off" : status.preferences.pinned ? "Pinned" :
          status.preferences.paused ? "Paused" : "Running"}</strong></div>
        <div><small>Next change</small><strong>{date(status?.nextDueUnix ?? null)}</strong></div>
        <div><small>Available images</small><strong>{status?.eligibleCount ?? "—"}</strong></div>
        <div><small>Offline reserve</small><strong>{status ? String(status.reserveCount) + "/10" : "—"}</strong></div>
      </div>
      <RotationPanel />
      <BackgroundPanel />
      <p className="hwr-schedule-note">
        Existing Library wallpapers are always preferred. Only verified public-domain/CC0 material is eligible for unattended discovery. Per-monitor schedules and category weighting come in later milestones.
      </p>
    </div>
  );
}
