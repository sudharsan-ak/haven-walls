import { useEffect, useState } from "react";
import type { WallpaperApplyResult } from "../lib/windowsWallpaper";
import {
  getRotationStatus, rotateNextWallpaper, saveRotationPreferences,
  type RotationPreferences, type RotationStatus, type DiscoveryTopic,
} from "../lib/rotation";
import "./RotationPanel.css";

const DISCOVERY_TOPICS: { id: DiscoveryTopic; label: string }[] = [
  { id: "nature", label: "Nature" },
  { id: "space", label: "Space" },
  { id: "cities", label: "Cities" },
  { id: "mountains", label: "Mountains" },
  { id: "oceans", label: "Oceans" },
  { id: "wildlife", label: "Wildlife" },
  { id: "architecture", label: "Architecture" },
  { id: "abstract", label: "Abstract" },
];

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
  const [topicsOpen, setTopicsOpen] = useState(false);

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
  const selectedTopics = prefs?.discoveryTopics ?? [];
  const allTopicsSelected = selectedTopics.length === DISCOVERY_TOPICS.length;
  const lastDiscoveryLabel = status?.lastDiscoveryOutcome === "saved"
    ? "Saved an approved image"
    : status?.lastDiscoveryOutcome === "no_match"
      ? "No new eligible image found"
      : status?.lastDiscoveryOutcome === "error" ? "Source request failed" : "";
  const lastTopicName = DISCOVERY_TOPICS.find((topic) =>
    topic.id === status?.lastDiscoveryTopic)?.label || status?.lastDiscoveryTopic;
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
            <div className="hwr-topic-picker">
              <span className="hwr-topic-label">Auto-discovery topics</span>
              <button type="button" className="hwr-topic-trigger"
                disabled={busy || !prefs.discoveryEnabled}
                aria-expanded={topicsOpen}
                aria-controls="hwr-topic-options"
                onClick={() => setTopicsOpen((open) => !open)}>
                {allTopicsSelected ? "All topics (8)"
                  : `${selectedTopics.length} topic${selectedTopics.length === 1 ? "" : "s"} selected`}
                <span aria-hidden="true">{topicsOpen ? "▴" : "▾"}</span>
              </button>
              {topicsOpen && prefs.discoveryEnabled && (
                <div id="hwr-topic-options" className="hwr-topic-options"
                  role="group" aria-label="Choose automatic discovery topics">
                  <div className="hwr-topic-toolbar">
                    <button type="button" disabled={busy || allTopicsSelected}
                      onClick={() => void savePatch({
                        discoveryTopics: DISCOVERY_TOPICS.map((topic) => topic.id),
                      })}>Select all</button>
                    <span>Choose one or more topics</span>
                  </div>
                  <div className="hwr-topic-grid">
                    {DISCOVERY_TOPICS.map((topic) => {
                      const selected = selectedTopics.includes(topic.id);
                      return (
                        <label key={topic.id} className="hwr-topic-option">
                          <input type="checkbox" checked={selected}
                            disabled={busy || (selected && selectedTopics.length === 1)}
                            onChange={(event) => {
                              const updated = event.target.checked
                                ? DISCOVERY_TOPICS.map((entry) => entry.id).filter(
                                    (id) => id === topic.id || selectedTopics.includes(id))
                                : selectedTopics.filter((id) => id !== topic.id);
                              if (updated.length) void savePatch({ discoveryTopics: updated });
                            }} />
                          {topic.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
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
          {lastDiscoveryLabel && (
            <p className="hwr-note">
              Last discovery: {lastDiscoveryLabel}
              {lastTopicName ? ` · ${lastTopicName}` : ""}
              {status.lastDiscoveryUnix ? ` · ${localDate(status.lastDiscoveryUnix)}` : ""}
            </p>
          )}
          {status.lastDiscoveryError && <p className="hwr-error">Discovery error: {status.lastDiscoveryError}</p>}
          {status.lastError && <p className="hwr-note">{status.lastError}</p>}
        </>
      )}
      {error && <p className="hwr-error" role="alert">{error}</p>}
      {notice && <p className="hwr-success" role="status">{notice}</p>}
    </section>
  );
}
