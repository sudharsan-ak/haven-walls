import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getActiveWallpaperPreview, getWallpaperActivity, listWindowsMonitors,
  formatWallpaperLocalTime, type ActiveWallpaperPreview,
  type WallpaperActivity, type WallpaperApplyResult, type WindowsMonitor,
} from "../lib/windowsWallpaper";
import { listLibraryWallpapers, type LibraryWallpaper } from "../lib/wallpaperLibrary";
import { getRotationStatus, rotateNextWallpaper, type RotationStatus } from "../lib/rotation";
import {
  cachedWallpaperPreview, invalidateDashboardWallpaperCache, lastDashboardPreview,
  lastDashboardTarget, previousWallpaperActivity, rememberDashboardTarget,
  rememberVerifiedWallpaperActivity, rememberWallpaperPreview,
} from "../lib/dashboardPreviewCache";
import "./DashboardPage.css";

interface Props {
  onOpenAutomation: () => void;
  onOpenLibrary: (wallpaperId?: string) => void;
  onBrowseWallpapers: () => void;
  onDiscoverByCategory: () => void;
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
function nextDate(unix: number | null): string {
  return unix ? new Date(unix * 1000).toLocaleString() : "Not scheduled";
}

export default function DashboardPage({
  onOpenAutomation, onOpenLibrary, onBrowseWallpapers, onDiscoverByCategory,
}: Props) {
  // React unmounts Dashboard when another workspace page opens. Restoring
  // the last verified image avoids repeatedly decoding the same 4K/8K file.
  const [activity, setActivity] = useState<WallpaperActivity | null>(
    () => previousWallpaperActivity()
  );
  const [monitors, setMonitors] = useState<WindowsMonitor[]>([]);
  const [saved, setSaved] = useState<LibraryWallpaper[]>([]);
  const [rotation, setRotation] = useState<RotationStatus | null>(null);
  const [target, setTarget] = useState(() => lastDashboardTarget());
  const [preview, setPreview] = useState<ActiveWallpaperPreview | null>(
    () => lastDashboardPreview()
  );
  const [previewBusy, setPreviewBusy] = useState(() => !lastDashboardPreview());
  // A cached image can paint instantly, but a new visit only claims
  // "Windows confirmed" after the background OS verification succeeds.
  const [verifiedThisVisit, setVerifiedThisVisit] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [actionError, setActionError] = useState("");
  const [nextBusy, setNextBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const requestId = useRef(0);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    const [wallpaperResult, libraryResult, rotationResult, monitorResult] =
      await Promise.allSettled([
        getWallpaperActivity(), listLibraryWallpapers(),
        getRotationStatus(), listWindowsMonitors(),
      ]);
    if (!live.current) return;
    if (wallpaperResult.status === "fulfilled") {
      rememberVerifiedWallpaperActivity(wallpaperResult.value);
      setActivity(wallpaperResult.value);
      setVerifiedThisVisit(true);
      setPreviewError("");
    } else {
      setVerifiedThisVisit(false);
      setPreviewError(message(wallpaperResult.reason));
    }
    if (libraryResult.status === "fulfilled") setSaved(libraryResult.value);
    if (rotationResult.status === "fulfilled") setRotation(rotationResult.value);
    if (monitorResult.status === "fulfilled") setMonitors(monitorResult.value);
  }, []);

  useEffect(() => {
    live.current = true;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    let unlisten: (() => void) | null = null;
    void listen<WallpaperApplyResult>("rotation:applied", () => {
      if (live.current) {
        invalidateDashboardWallpaperCache();
        setVerifiedThisVisit(false);
        setPreview(null);
        setPreviewBusy(true);
        setPreviewRevision((revision) => revision + 1);
        void refresh();
      }
    }).then((stop) => { if (live.current) unlisten = stop; else stop(); })
      .catch(() => { /* Periodic refresh still verifies the OS state. */ });
    return () => {
      live.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [refresh]);

  const current = useMemo(() =>
    (activity?.current || []).filter((record) => record.isCurrent),
  [activity]);
  const selected = current.find((record) => record.targetId === target) || current[0] || null;
  const selectedTarget = selected?.targetId || "";
  // Never show a cached photo alongside a different display assignment,
  // even for one render while React schedules the preview effect.
  const shownPreview = preview && selected &&
    preview.targetId === selected.targetId &&
    preview.wallpaperId === selected.wallpaperId &&
    preview.appliedAt === selected.appliedAt ? preview : null;
  const applied = saved.find((item) => item.id === selected?.wallpaperId);
  const monitorName = (id: string) => id === "all" ? "All displays" :
    monitors.find((monitor) => monitor.id === id)?.name || "Selected display";

  useEffect(() => {
    const id = ++requestId.current;
    if (!selectedTarget) {
      setPreview(null);
      setPreviewBusy(false);
      return;
    }
    const cached = cachedWallpaperPreview(selected);
    if (cached) {
      setPreview(cached);
      setPreviewBusy(false);
      setPreviewError("");
      return; // OS activity is still checked by the independent refresh.
    }
    setPreview(null);
    setPreviewBusy(true);
    setPreviewError("");
    void getActiveWallpaperPreview(selectedTarget).then((image) => {
      if (live.current && id === requestId.current) {
        rememberWallpaperPreview(image);
        setPreview(image);
        setPreviewBusy(false);
      }
    }).catch((reason: unknown) => {
      if (live.current && id === requestId.current) {
        setPreview(null);
        setPreviewError(message(reason));
        setPreviewBusy(false);
      }
    });
  }, [selectedTarget, selected?.wallpaperId, selected?.appliedAt, previewRevision]);

  async function nextWallpaper() {
    if (nextBusy) return;
    setNextBusy(true);
    setActionError("");
    try {
      const applied = await rotateNextWallpaper();
      rememberDashboardTarget(applied.targetId);
      setTarget(applied.targetId);
      setPreviewBusy(true);
      // Read the same Windows-confirmed working copy that was just applied,
      // rather than relying on an immediate OS activity read that can lag.
      try {
        const current = await getActiveWallpaperPreview(applied.targetId);
        if (live.current) {
          rememberWallpaperPreview(current);
          setPreview(current);
          setPreviewError("");
          setPreviewBusy(false);
        }
      } catch {
        // The Windows activity poll will refresh the image on the next pass.
        setPreview(null);
      }
      await refresh();
    } catch (reason) {
      setActionError(message(reason));
    } finally {
      setNextBusy(false);
    }
  }

  const prefs = rotation?.preferences;
  const rotationLabel = !prefs ? "Checking…" : !prefs.enabled ? "Off" :
    prefs.pinned ? "Pinned" : prefs.paused ? "Paused" : "Running";
  const wallpaperTitle = shownPreview?.title || selected?.title || "";
  const wallpaperDescription = applied?.source ||
    (selected ? "Approved offline reserve or previously saved wallpaper" : "");
  const displayedTime = shownPreview?.appliedAt || selected?.appliedAt;

  return (
    <section className="hwd-dashboard">
      <div className="eyebrow">Haven Walls / Desktop overview</div>
      <h1>Dashboard</h1>
      <p className="subheading">Your current desktop and upcoming wallpaper changes, all in one place.</p>

      <div className="hwd-current-card">
        <div className="hwd-current-image">
          {shownPreview?.dataUrl ? (
            <img src={shownPreview.dataUrl} alt={"Active Windows wallpaper: " + wallpaperTitle} />
          ) : (
            <div className="hwd-image-placeholder" role="status">
              <span aria-hidden="true">▧</span>
              {previewBusy ? (
                <span>Loading current desktop wallpaper…</span>
              ) : !selected ? (
                <>
                  <strong>Make your desktop yours</strong>
                  <p>Choose a wallpaper from Library or discover a new one in Gallery.</p>
                  <div className="hwd-empty-actions">
                    <button type="button" onClick={() => onOpenLibrary()}>Open Library</button>
                    <button type="button" onClick={onBrowseWallpapers}>Browse Gallery</button>
                  </div>
                </>
              ) : (
                <span>The current Windows wallpaper preview is unavailable.</span>
              )}
            </div>
          )}
          <span className="hwd-image-top">● &nbsp; {selected ? "Current wallpaper" : "Wallpaper preview"}</span>
          <span className="hwd-image-display">{selected ? monitorName(selected.targetId) : "Windows desktop"}</span>
          {shownPreview && (
            <button type="button" className="hwd-expand" aria-label="Expand wallpaper preview"
              title="Expand current wallpaper" onClick={() => setExpanded(true)}>⤢</button>
          )}
        </div>
        <div className="hwd-current-details">
          <div className="hwd-overline">Now on your desktop</div>
          <div className="hwd-state"><span className="hwd-dot"/> {selected
            ? verifiedThisVisit ? "Windows confirmed"
              : previewError ? "Windows status unavailable" : "Checking Windows status…"
            : "Not confirmed"}</div>
          <h2 title={wallpaperTitle || undefined}>{wallpaperTitle || "Your Windows desktop"}</h2>
          <p className="hwd-source">{wallpaperDescription ||
            "Set an image from your Library to start managing this desktop."}</p>
          {current.length > 1 && (
            <label className="hwd-monitor-picker">
              <span>Display</span>
              <select value={selectedTarget} onChange={(event) => {
                rememberDashboardTarget(event.target.value);
                setTarget(event.target.value);
              }}>
                {current.map((entry) => <option key={entry.targetId} value={entry.targetId}>
                  {monitorName(entry.targetId)}
                </option>)}
              </select>
            </label>
          )}
          <div className="hwd-details-grid">
            <div><small>Applied to</small><strong>{selected ? monitorName(selected.targetId) : "Not assigned"}</strong></div>
            <div><small>Resolution</small><strong>{shownPreview ? shownPreview.width + " × " + shownPreview.height : "—"}</strong></div>
            <div><small>Format</small><strong>{shownPreview ? "JPG working copy" : "—"}</strong></div>
            <div><small>Last changed</small><strong>{displayedTime ? formatWallpaperLocalTime(displayedTime) : "—"}</strong></div>
          </div>
          <div className="hwd-actions">
            <button type="button" className="hwd-primary" disabled={nextBusy}
              onClick={() => void nextWallpaper()}>{nextBusy ? "Changing…" : "↻  Next wallpaper"}</button>
            <button type="button" className="hwd-secondary" disabled={!applied}
              title={applied ? "Open this wallpaper's Library details" : "Offline reserve images are not in your permanent Library"}
              onClick={() => { if (applied) onOpenLibrary(applied.id); }}>View in Library</button>
            <button type="button" className="hwd-text-action" onClick={() => onOpenLibrary()}>
              Change wallpaper →
            </button>
          </div>
          {actionError && <p className="hwd-error" role="alert">{actionError}</p>}
          {previewError && <p className="hwd-context">{previewError}</p>}
          <p className="hwd-context">▣ Protected local working copy · {verifiedThisVisit
            ? "Confirmed against Windows"
            : previewError ? "Windows verification unavailable" : "Verifying Windows status"}</p>
        </div>
      </div>

      <section className="hwd-rotation-card" aria-label="Rotation status">
        <div className="hwd-rotation-heading">
          <div className="hwd-rotation-icon" aria-hidden="true">↻</div>
          <div><h2>Automatic rotation</h2><p>Wallpapers change based on your saved preferences.</p></div>
          <span className={"hwd-rotation-pill" + (prefs?.enabled && !prefs.paused && !prefs.pinned ? " on" : "")}>{rotationLabel}</span>
        </div>
        <div className="hwd-rotation-metrics">
          <div><small>Next change</small><strong>{prefs?.enabled && !prefs.paused && !prefs.pinned ?
            nextDate(rotation?.nextDueUnix ?? null) : "Not actively rotating"}</strong>
            <small>{prefs?.scheduleMode === "daily" ? "Daily at " + prefs.dailyTime + " local time" :
              prefs ? "Every " + prefs.intervalMinutes + " minutes" : "Local schedule"}</small></div>
          <div><small>Available images</small><strong>{rotation?.eligibleCount ?? "—"} wallpapers</strong>
            <small>Library + approved reserve</small></div>
          <div><small>Offline reserve</small><strong>{rotation?.reserveCount ?? "—"} / 10</strong>
            <small>Available without internet</small></div>
          <button type="button" className="hwd-secondary" onClick={onOpenAutomation}>Manage rotation →</button>
        </div>
        {rotation && rotation.eligibleCount === 0 && (
          <div className="hwd-rotation-empty" role="status">
            <span>No wallpapers available for rotation yet. Add images to Library or turn on approved discovery.</span>
            <button type="button" onClick={() => onOpenLibrary()}>Open Library</button>
            <button type="button" onClick={onOpenAutomation}>Discovery settings</button>
          </div>
        )}
      </section>

      <div className="hwd-quick-heading"><h2>Quick access</h2><p>Jump straight into wallpaper management.</p></div>
      <div className="hwd-shortcuts">
        <button type="button" onClick={onBrowseWallpapers}>
          <span className="hwd-shortcut-icon">▧</span>
          <span><strong>Browse wallpapers</strong><small>Explore and discover new images</small></span><span>→</span>
        </button>
        <button type="button" onClick={() => onOpenLibrary()}>
          <span className="hwd-shortcut-icon">▣</span>
          <span><strong>Wallpaper Library</strong><small>Your saved and favorite images</small></span><span>→</span>
        </button>
        <button type="button" onClick={onDiscoverByCategory}>
          <span className="hwd-shortcut-icon">✧</span>
          <span><strong>Discover by Category</strong><small>Explore nature, space, sports and more</small></span><span>→</span>
        </button>
      </div>
      {expanded && shownPreview && (
        <div className="hwd-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}>
          <div className="hwd-lightbox-dialog" role="dialog" aria-modal="true" aria-label="Current desktop wallpaper preview"
            onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" aria-label="Close expanded preview" onClick={() => setExpanded(false)}>×</button>
            <img src={shownPreview.dataUrl} alt={wallpaperTitle}/>
            <p>{wallpaperTitle} · {monitorName(shownPreview.targetId)} · {shownPreview.width} × {shownPreview.height}</p>
          </div>
        </div>
      )}
    </section>
  );
}
