import { useEffect, useState } from "react";
import { getRotationStatus, type RotationStatus } from "../lib/rotation";
import "./RotationPage.css";

export default function RotationDashboard({ onOpen }: { onOpen: () => void }) {
  const [state, setState] = useState<RotationStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => { void getRotationStatus().then((value) => {
      if (live) setState(value);
    }).catch(() => {}); };
    load();
    const id = window.setInterval(load, 15000);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  const prefs = state?.preferences;
  const status = !prefs ? "Checking…" : !prefs.enabled ? "Off" :
    prefs.pinned ? "Pinned" : prefs.paused ? "Paused" : "Running";
  return (
    <section className="hwr-dashboard" aria-label="Automatic wallpaper rotation">
      <div>
        <h2>Automatic wallpaper rotation</h2>
        <p><strong>{status}</strong> · {state?.eligibleCount ?? 0} available images · Offline reserve {state?.reserveCount ?? 0}/10</p>
        <p>Next: {state?.nextDueUnix && prefs?.enabled && !prefs.paused && !prefs.pinned
          ? new Date(state.nextDueUnix * 1000).toLocaleString() : "No active scheduled change"}</p>
      </div>
      <button type="button" onClick={onOpen}>Manage schedule</button>
    </section>
  );
}
