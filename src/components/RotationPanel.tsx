import { useEffect, useState } from "react";
import type { WallpaperApplyResult } from "../lib/windowsWallpaper";
import {
  getRotationStatus, rotateNextWallpaper, saveRotationPreferences,
  type RotationPreferences, type RotationStatus,
} from "../lib/rotation";
import "./RotationPanel.css";

const PRESETS = [
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Every 24 hours" },
];
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function localDate(unix: number | null): string {
  if (unix === null) return "Not scheduled";
  return new Date(unix * 1000).toLocaleString();
}
interface Props {
  onApplied: (result: WallpaperApplyResult) => void;
}
export default function RotationPanel({ onApplied }: Props) {
  const [status, setStatus] = useState<RotationStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("120");
  const [customDays, setCustomDays] = useState("30");

  useEffect(() => {
    let live = true;
    void getRotationStatus().then((value) => {
      if (live) {
        setStatus(value);
        setCustomMinutes(String(value.preferences.intervalMinutes));
        setCustomDays(String(value.preferences.cooldownDays));
      }
    }).catch((reason: unknown) => {
      if (live) setError(errorMessage(reason));
    });
    const timer = window.setInterval(() => {
      if (!busy) {
        void getRotationStatus().then((value) => {
          if (live) setStatus(value);
        }).catch(() => { /* Interactive operations surface errors. */ });
      }
    }, 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, [busy]);

  async function savePatch(patch: Partial<RotationPreferences>) {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await saveRotationPreferences({ ...status.preferences, ...patch });
      setStatus(updated);
      setCustomMinutes(String(updated.preferences.intervalMinutes));
      setCustomDays(String(updated.preferences.cooldownDays));
      setNotice("Rotation preferences saved.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function next() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await rotateNextWallpaper();
      onApplied(result);
      setStatus(await getRotationStatus());
      setNotice("Wallpaper changed.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const prefs = status?.preferences;
  const isPreset = PRESETS.some((p) => p.minutes === prefs?.intervalMinutes);
  return (
    <section className="hwr-panel" aria-label="Library rotation controls">
      <div className="hwr-heading">
        <div>
          <strong>Automatic wallpaper rotation</strong>
          <p>Rotate saved Library wallpapers first, then approved offline reserve images. Automatic public-domain discovery fills the reserve while Haven Walls is running.</p>
        </div>
        <span className={"hwr-indicator" + (prefs?.enabled && !prefs.paused && !prefs.pinned ? " on" : "")}>
          {!prefs ? "Loading…" : !prefs.enabled ? "Off" : prefs.pinned ? "Pinned" : prefs.paused ? "Paused" : "On"}
        </span>
      </div>
      {status && prefs && (
        <>
          <div className="hwr-fields">
            <label>
              <span>Change every</span>
              <select disabled={busy} value={isPreset ? String(prefs.intervalMinutes) : "custom"}
                onChange={(e) => {
                  const minutes = e.target.value === "custom" ? 120 : Number(e.target.value);
                  void savePatch({ intervalMinutes: minutes });
                }}>
                {PRESETS.map((option) => (
                  <option key={option.minutes} value={option.minutes}>{option.label}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
            {!isPreset && (
              <label>
                <span>Custom interval (minutes)</span>
                <input type="number" min={15} max={10080} step={15} disabled={busy}
                  value={customMinutes} onChange={(e) => setCustomMinutes(e.target.value)}
                  onBlur={() => {
                    const minutes = Number(customMinutes);
                    if (Number.isInteger(minutes) && minutes >= 15 && minutes <= 10080
                      && minutes !== prefs.intervalMinutes) {
                      void savePatch({ intervalMinutes: minutes });
                    } else {
                      setCustomMinutes(String(prefs.intervalMinutes));
                    }
                  }} />
              </label>
            )}
            <label>
              <span>No repeat for (days)</span>
              <input type="number" min={1} max={365} step={1} disabled={busy}
                value={customDays} onChange={(e) => setCustomDays(e.target.value)}
                onBlur={() => {
                  const days = Number(customDays);
                  if (Number.isInteger(days) && days >= 1 && days <= 365
                    && days !== prefs.cooldownDays) {
                    void savePatch({ cooldownDays: days });
                  } else {
                    setCustomDays(String(prefs.cooldownDays));
                  }
                }} />
            </label>
            <label className="hwr-check">
              <input type="checkbox" checked={prefs.favoritesOnly} disabled={busy}
                onChange={(e) => void savePatch({ favoritesOnly: e.target.checked })} />
              Favorites only
            </label>
            <label className="hwr-check">
              <input type="checkbox" checked={prefs.discoveryEnabled} disabled={busy}
                onChange={(e) => void savePatch({ discoveryEnabled: e.target.checked })} />
              Discover approved public-domain images automatically
            </label>
            <label>
              <span>Auto-discovery topic</span>
              <select value={prefs.discoveryTopic} disabled={busy || !prefs.discoveryEnabled}
                onChange={(e) => void savePatch({
                  discoveryTopic: e.target.value as RotationPreferences["discoveryTopic"],
                })}>
                <option value="nature">Nature</option>
                <option value="space">Space</option>
                <option value="cities">Cities</option>
              </select>
            </label>
          </div>
          <div className="hwr-actions">
            <button type="button" disabled={busy} className={prefs.enabled ? "hwr-secondary" : "hwr-primary"}
              onClick={() => void savePatch({ enabled: !prefs.enabled })}>
              {prefs.enabled ? "Turn rotation off" : "Enable rotation"}
            </button>
            <button type="button" disabled={busy || !prefs.enabled} className="hwr-secondary"
              onClick={() => void savePatch({ paused: !prefs.paused })}>
              {prefs.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" disabled={busy || !prefs.enabled} className="hwr-secondary"
              onClick={() => void savePatch({ pinned: !prefs.pinned })}>
              {prefs.pinned ? "Unpin current" : "Pin current"}
            </button>
            <button type="button" disabled={busy || prefs.pinned ||
                (status.eligibleCount === 0 &&
                  (!prefs.enabled || !prefs.discoveryEnabled || prefs.favoritesOnly))}
              className="hwr-primary"
              onClick={() => void next()}>
              {busy ? "Working…" : "Next wallpaper"}
            </button>
          </div>
          <div className="hwr-meta">
            <span>{status.eligibleCount} eligible rotation image{status.eligibleCount === 1 ? "" : "s"}</span>
            <span>Offline reserve: {status.reserveCount}/10</span>
            <span>Next rotation: {prefs.enabled && !prefs.paused && !prefs.pinned
              ? localDate(status.nextDueUnix) : "Not actively rotating"}</span>
            {prefs.enabled && prefs.discoveryEnabled && !prefs.favoritesOnly && (
              <span>Next discovery: {localDate(status.nextDiscoveryUnix)}</span>
            )}
          </div>
          <p className="hwr-note">Automatic source: verified public-domain/CC0 Wikimedia Commons images. Bing Daily and Unsplash remain available for manual selection while unattended provider use is reviewed. Offline reserve files are separate from your permanent Library. Favorites-only does not use the reserve.</p>
          {status.lastDiscoveryError && <p className="hwr-note">Discovery: {status.lastDiscoveryError}</p>}
          {status.lastError && <p className="hwr-note">{status.lastError}</p>}
        </>
      )}
      {error && <p className="hwr-error" role="alert">{error}</p>}
      {notice && <p className="hwr-success" role="status">{notice}</p>}
    </section>
  );
}
