import { useEffect, useRef, useState } from "react";
import { getPersonalization, type NamedGroup } from "../lib/personalization";
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
  onApplied?: (result: WallpaperApplyResult) => void;
  onStatusChange?: (status: RotationStatus) => void;
  onOpenCollections?: () => void;
}
export default function RotationPanel({ onApplied, onStatusChange, onOpenCollections }: Props) {
  const [status, setStatus] = useState<RotationStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("120");
  const [customDays, setCustomDays] = useState("30");
  const [dailyDraft, setDailyDraft] = useState("09:00");
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [collections, setCollections] = useState<NamedGroup[]>([]);
  const [collectionCounts, setCollectionCounts] = useState<Record<string, number>>({});
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [collectionsError, setCollectionsError] = useState("");
  const [scopeDraft, setScopeDraft] = useState<RotationPreferences["rotationScope"]>("all");
  const [collectionIdsDraft, setCollectionIdsDraft] = useState<string[]>([]);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const editingScope = useRef(false);

  useEffect(() => {
    let live = true;
    void getRotationStatus().then((value) => {
      if (live) {
        setStatus(value);
        setCustomMinutes(String(value.preferences.intervalMinutes));
        setCustomDays(String(value.preferences.cooldownDays));
        setDailyDraft(value.preferences.dailyTime);
        if (!editingScope.current) {
          setScopeDraft(value.preferences.rotationScope);
          setCollectionIdsDraft(value.preferences.collectionIds);
        }
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

  useEffect(() => {
    let live = true;
    void getPersonalization().then((snapshot) => {
      if (!live) return;
      setCollections(snapshot.collections);
      const counts: Record<string, number> = {};
      for (const link of snapshot.wallpaperCollections) {
        counts[link.groupId] = (counts[link.groupId] ?? 0) + 1;
      }
      setCollectionCounts(counts);
      setCollectionsError("");
    }).catch((reason: unknown) => {
      if (live) setCollectionsError(errorMessage(reason));
    }).finally(() => {
      if (live) setCollectionsLoading(false);
    });
    return () => { live = false; };
  }, []);

  async function savePatch(patch: Partial<RotationPreferences>): Promise<boolean> {
    if (!status || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await saveRotationPreferences({ ...status.preferences, ...patch });
      setStatus(updated);
      onStatusChange?.(updated);
      setCustomMinutes(String(updated.preferences.intervalMinutes));
      setCustomDays(String(updated.preferences.cooldownDays));
      setDailyDraft(updated.preferences.dailyTime);
      setNotice("Rotation preferences saved.");
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyCollectionSelection() {
    if (busy || collectionsLoading || collectionsError ||
        (scopeDraft === "collections" && collectionIdsDraft.length === 0)) return;
    const saved = await savePatch({
      rotationScope: scopeDraft, collectionIds: collectionIdsDraft,
    });
    if (saved) editingScope.current = false;
  }

  async function next() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await rotateNextWallpaper();
      onApplied?.(result);
      const updated = await getRotationStatus();
      setStatus(updated);
      onStatusChange?.(updated);
      setNotice("Wallpaper changed.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const prefs = status?.preferences;
  const selectionChanged = Boolean(prefs &&
    (scopeDraft !== prefs.rotationScope ||
      JSON.stringify([...collectionIdsDraft].sort()) !==
      JSON.stringify([...prefs.collectionIds].sort())));
  const missingCollections = collectionIdsDraft.filter(
    (id) => !collections.some((group) => group.id === id));
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
  const rateLimited = Boolean(status?.lastDiscoveryError &&
    (status.lastDiscoveryError.includes("429") ||
      status.lastDiscoveryError.includes("503")));
  const discoveryState = !prefs?.enabled || !prefs.discoveryEnabled
    ? "Discovery off"
    : prefs.favoritesOnly ? "Favorites only"
    : (status?.reserveCount ?? 0) >= 10 ? "Reserve full"
    : rateLimited ? "Cooling down"
    : status?.lastDiscoveryOutcome === "error" ? "Source unavailable"
    : status?.lastDiscoveryOutcome === "saved" ? "Image saved"
    : status?.lastDiscoveryOutcome === "no_match" ? "No eligible result"
    : "Ready to discover";
  return (
    <section className="hwr-panel" aria-label="Automatic wallpaper rotation settings">
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
              <span>Schedule</span>
              <select value={prefs.scheduleMode} disabled={busy}
                onChange={(e) => void savePatch({
                  scheduleMode: e.target.value as RotationPreferences["scheduleMode"],
                })}>
                <option value="interval">Repeat at an interval</option>
                <option value="daily">Every day at a time</option>
              </select>
            </label>
            {prefs.scheduleMode === "daily" && (
              <label>
                <span>Local Windows time</span>
                <input type="time" value={dailyDraft} disabled={busy}
                  onChange={(e) => setDailyDraft(e.target.value)}
                  onBlur={() => {
                    if (/^\d{2}:\d{2}$/.test(dailyDraft) &&
                        dailyDraft !== prefs.dailyTime) {
                      void savePatch({ dailyTime: dailyDraft });
                    } else setDailyDraft(prefs.dailyTime);
                  }} />
              </label>
            )}
            {prefs.scheduleMode === "interval" && <label>
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
            </label>}
            {prefs.scheduleMode === "interval" && !isPreset && (
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
          </div>
          <section className="hwr-collection-scope" aria-label="Rotation collection selection">
            <div className="hwr-collection-heading">
              <div>
                <strong>Rotate wallpapers from</strong>
                <p>Use your entire Library or only the saved wallpapers in selected collections.
                  Collection rotation never substitutes unrelated offline reserve images.</p>
              </div>
              <span>{status.eligibleCount} eligible</span>
            </div>
            <div className="hwr-scope-radios" role="radiogroup" aria-label="Wallpaper rotation pool">
              <label>
                <input type="radio" name="hwr-scope" value="all" checked={scopeDraft === "all"}
                  disabled={busy || collectionsLoading}
                  onChange={() => { editingScope.current = true; setScopeDraft("all"); }}/>
                Entire Library
              </label>
              <label>
                <input type="radio" name="hwr-scope" value="collections"
                  checked={scopeDraft === "collections"}
                  disabled={busy || collectionsLoading || Boolean(collectionsError)}
                  onChange={() => {
                    editingScope.current = true;
                    setScopeDraft("collections");
                    setSelectionOpen(true);
                  }}/>
                Selected collections
              </label>
            </div>
            {scopeDraft === "collections" && (
              <div className="hwr-collection-picker">
                <button type="button" className="hwr-collection-trigger"
                  aria-expanded={selectionOpen} aria-controls="hwr-collection-options"
                  disabled={busy || collectionsLoading}
                  onClick={() => setSelectionOpen((open) => !open)}>
                  {collectionIdsDraft.length} collection{collectionIdsDraft.length === 1 ? "" : "s"} selected
                  <span aria-hidden="true">{selectionOpen ? "▴" : "▾"}</span>
                </button>
                {selectionOpen && (
                  <div id="hwr-collection-options" className="hwr-collection-options"
                    role="group" aria-label="Choose saved wallpaper collections">
                    {collections.length === 0 && !collectionsLoading && (
                      <p>No collections yet. Create one under Library → Collections, then add saved wallpapers.</p>
                    )}
                    {collections.map((group) => (
                      <label key={group.id} className="hwr-collection-option">
                        <input type="checkbox" disabled={busy}
                          checked={collectionIdsDraft.includes(group.id)}
                          onChange={(event) => {
                            editingScope.current = true;
                            const checked = event.target.checked;
                            setCollectionIdsDraft((before) => checked
                              ? [...before, group.id]
                              : before.filter((id) => id !== group.id));
                          }}/>
                        <span>{group.name}</span>
                        <small>{collectionCounts[group.id] ?? 0} saved</small>
                      </label>
                    ))}
                    {missingCollections.length > 0 && (
                      <div className="hwr-collection-missing" role="status">
                        {missingCollections.length} previously selected collection(s) no longer exist.
                        <button type="button" disabled={busy}
                          onClick={() => {
                            editingScope.current = true;
                            setCollectionIdsDraft((before) =>
                              before.filter((id) => !missingCollections.includes(id)));
                          }}>Remove missing</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {collectionsError && <p className="hwr-error" role="alert">
              Could not read saved collections: {collectionsError}</p>}
            {scopeDraft === "collections" && collectionIdsDraft.length === 0 && (
              <p className="hwr-note">Choose at least one collection to enable this mode.</p>
            )}
            <div className="hwr-scope-actions">
              {onOpenCollections && <button type="button" onClick={onOpenCollections}
                className="hwr-secondary">Manage collections in Library</button>}
              <button type="button" className="hwr-primary"
                disabled={busy || collectionsLoading || Boolean(collectionsError) ||
                  !selectionChanged || (scopeDraft === "collections" && collectionIdsDraft.length === 0)}
                onClick={() => void applyCollectionSelection()}>
                {busy ? "Saving…" : "Apply rotation selection"}
              </button>
            </div>
          </section>
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
                  (prefs.rotationScope === "collections" ||
                    !prefs.enabled || !prefs.discoveryEnabled || prefs.favoritesOnly))}
              className="hwr-primary"
              onClick={() => void next()}>
              {busy ? "Working…" : "Next wallpaper"}
            </button>
          </div>
          <div className="hwr-discovery-block">
            <div className="hwr-discovery-heading">
              <strong>Automatic discovery &amp; offline reserve</strong>
              <p>Refill with approved wallpaper images when the saved rotation pool needs more variety.</p>
            </div>
            <div className="hwr-discovery-fields">
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
          </div>
          <div className="hwr-meta">
            <span>{status.eligibleCount} eligible rotation image{status.eligibleCount === 1 ? "" : "s"}</span>
            <span>Next rotation: {prefs.enabled && !prefs.paused && !prefs.pinned
              ? localDate(status.nextDueUnix) : "Not actively rotating"}</span>
          </div>
          <section className="hwr-discovery-status" aria-label="Automatic discovery status">
            <div className="hwr-discovery-status-head">
              <div>
                <strong>Offline reserve</strong>
                <span>{status.reserveCount} / 10 wallpapers</span>
              </div>
              <span className={"hwr-discovery-state" + (rateLimited ? " is-limited" : "")}>
                {discoveryState}
              </span>
            </div>
            <progress value={Math.min(status.reserveCount, 10)} max={10}
              aria-label="Approved offline reserve filled" />
            <div className="hwr-discovery-details">
              {lastDiscoveryLabel && (
                <span>Last attempt: {lastDiscoveryLabel}
                  {lastTopicName ? ` · ${lastTopicName}` : ""}
                  {status.lastDiscoveryUnix ? ` · ${localDate(status.lastDiscoveryUnix)}` : ""}
                </span>
              )}
              {prefs.enabled && prefs.discoveryEnabled && !prefs.favoritesOnly && (
                <span>Next check: {status.reserveCount >= 10
                  ? "Reserve is full" : localDate(status.nextDiscoveryUnix)}</span>
              )}
            </div>
            {rateLimited && (
              <p className="hwr-discovery-advice" role="status">
                Wikimedia is temporarily limiting requests. Existing saved wallpapers
                can still rotate; Haven Walls will retry after the provider cooldown.
              </p>
            )}
            {status.lastDiscoveryError && !rateLimited && (
              <p className="hwr-discovery-advice">The last source request did not complete.
                Saved Library and reserve images remain available.</p>
            )}
            <details className="hwr-tech-details">
              <summary>Source policy &amp; technical details</summary>
              <p>Automatic discovery uses individually verified public-domain/CC0 Wikimedia Commons images.
                Bing Daily and Unsplash are available for manual discovery only.
                Favorites-only never uses the offline reserve.</p>
              {status.lastDiscoveryError && <p>Last provider response: {status.lastDiscoveryError}</p>}
              {status.lastError && <p>Rotation issue: {status.lastError}</p>}
            </details>
          </section>
          {status.lastError && <p className="hwr-error" role="alert">{status.lastError}</p>}
        </>
      )}
      {error && <p className="hwr-error" role="alert">{error}</p>}
      {notice && <p className="hwr-success" role="status">{notice}</p>}
    </section>
  );
}
