import { useEffect, useRef, useState } from "react";
import {
  backupNow, chooseBackupFolder, getBackupStatus, saveBackupPreferences,
  type BackupPreferences, type BackupStatus,
} from "../lib/backup";
import { formattedBytes } from "../lib/configuration";
import "./BackupRestoreSettings.css";

const DAYS = [
  { id: 1, label: "Monday" }, { id: 2, label: "Tuesday" },
  { id: 3, label: "Wednesday" }, { id: 4, label: "Thursday" },
  { id: 5, label: "Friday" }, { id: 6, label: "Saturday" },
  { id: 7, label: "Sunday" },
];
function describeError(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}
function when(unix: number | null): string {
  return unix == null ? "Not scheduled" : new Date(unix * 1000).toLocaleString();
}
export default function BackupRestoreSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [draft, setDraft] = useState<BackupPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "backup" | "browse" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editedRef = useRef(false);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      void getBackupStatus().then((next) => {
        if (!live) return;
        setStatus(next);
        if (!editedRef.current) setDraft(next.preferences);
        setError("");
      }).catch((problem) => {
        if (live) setError(describeError(problem));
      }).finally(() => {
        if (live) setLoading(false);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 15000);
    return () => { live = false; window.clearInterval(interval); };
  }, []);

  function edit<K extends keyof BackupPreferences>(key: K, value: BackupPreferences[K]) {
    editedRef.current = true;
    setDraft((existing) => existing ? { ...existing, [key]: value } : null);
    setError("");
    setNotice("");
  }

  const changed = Boolean(status && draft &&
    JSON.stringify(status.preferences) !== JSON.stringify(draft));

  async function pickFolder() {
    if (busy) return;
    setBusy("browse"); setError(""); setNotice("");
    try {
      const folder = await chooseBackupFolder();
      if (folder !== null) edit("destination", folder);
    } catch (problem) {
      setError(describeError(problem));
    } finally { setBusy(null); }
  }
  async function save() {
    if (!draft || busy) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const updated = await saveBackupPreferences(draft);
      setStatus(updated);
      setDraft(updated.preferences);
      editedRef.current = false;
      setNotice("Backup preferences saved locally.");
    } catch (problem) {
      setError(describeError(problem));
    } finally { setBusy(null); }
  }
  async function runBackup() {
    if (busy || !status || changed) return;
    setBusy("backup"); setError(""); setNotice("");
    try {
      const updated = await backupNow();
      setStatus(updated);
      setDraft(updated.preferences);
      setNotice("Backup created and verified successfully.");
    } catch (problem) {
      setError(describeError(problem));
      void getBackupStatus().then(setStatus).catch(() => {});
    } finally { setBusy(null); }
  }

  if (loading) {
    return <section className="hwb-page" role="status">Loading backup preferences…</section>;
  }
  if (!draft || !status) {
    return <section className="hwb-page"><p role="alert" className="hwb-error">
      {error || "Backup settings are not available."}</p></section>;
  }
  const hasDestination = draft.destination.trim().length > 0;
  const ready = hasDestination && !changed && !busy;
  return (
    <div className="hwb-page">
      <p className="hws-settings-intro">
        Back up your Haven Walls preferences and saved Library images to a folder you choose.
        Everything stays on your PC or a drive you select.
      </p>

      <section className="hwb-panel" aria-labelledby="hwb-auto-title">
        <div className="hwb-heading">
          <div>
            <h2 id="hwb-auto-title">Automatic backups</h2>
            <p>Scheduled backups run in the background while Haven Walls is running,
              including when the window is hidden in the system tray.</p>
          </div>
          <label className="hwb-enabled">
            <input type="checkbox" checked={draft.enabled} disabled={busy !== null}
              onChange={(event) => edit("enabled", event.target.checked)} />
            {draft.enabled ? "On" : "Off"}
          </label>
        </div>
        <div className="hwb-field">
          <label htmlFor="hwb-folder">Backup destination folder</label>
          <div className="hwb-folder-row">
            <input id="hwb-folder" type="text" value={draft.destination}
              placeholder="Choose a folder, for example D:\HavenWalls\Backups"
              spellCheck={false} disabled={busy !== null}
              onChange={(event) => edit("destination", event.target.value)} />
            <button type="button" className="hwb-secondary"
              disabled={busy !== null} onClick={() => void pickFolder()}>
              Browse…
            </button>
          </div>
          <small>Choose an existing writable folder. If the drive is disconnected,
            existing backups stay untouched and automatic backups retry later.</small>
        </div>
        <div className="hwb-field-grid">
          <div className="hwb-field">
            <label htmlFor="hwb-frequency">Backup frequency</label>
            <select id="hwb-frequency" value={draft.frequency}
              disabled={busy !== null}
              onChange={(event) => edit("frequency",
                event.target.value as BackupPreferences["frequency"])}>
              <option value="daily">Daily at a set time</option>
              <option value="weekly">Weekly</option>
              <option value="interval">Every N hours</option>
            </select>
          </div>
          {draft.frequency === "weekly" && (
            <div className="hwb-field">
              <label htmlFor="hwb-weekday">Day of week</label>
              <select id="hwb-weekday" value={draft.weekday} disabled={busy !== null}
                onChange={(event) => edit("weekday", Number(event.target.value))}>
                {DAYS.map((day) => <option key={day.id} value={day.id}>{day.label}</option>)}
              </select>
            </div>
          )}
          {draft.frequency !== "interval" ? (
            <div className="hwb-field">
              <label htmlFor="hwb-time">Time (Windows local)</label>
              <input id="hwb-time" type="time" value={draft.time}
                disabled={busy !== null}
                onChange={(event) => edit("time", event.target.value)} />
            </div>
          ) : (
            <div className="hwb-field">
              <label htmlFor="hwb-interval">Repeat every (hours)</label>
              <input id="hwb-interval" type="number" min={1} max={168} step={1}
                disabled={busy !== null} value={draft.intervalMinutes / 60}
                onChange={(event) => edit("intervalMinutes", Number(event.target.value) * 60)} />
              <small>24 = every 24 hours; 168 = every week.</small>
            </div>
          )}
          <div className="hwb-field">
            <label htmlFor="hwb-type">Backup contents</label>
            <select id="hwb-type" value={draft.backupType} disabled={busy !== null}
              onChange={(event) => edit("backupType",
                event.target.value as BackupPreferences["backupType"])}>
              <option value="full">Full Library + Settings</option>
              <option value="settings">Settings only</option>
            </select>
          </div>
          <div className="hwb-field">
            <label htmlFor="hwb-retention">Keep latest successful backups</label>
            <input id="hwb-retention" type="number" min={1} max={30} step={1}
              value={draft.retention} disabled={busy !== null}
              onChange={(event) => edit("retention", Number(event.target.value))} />
            <small>1 = keep the newest only. The previous backup is retained until
              the replacement is verified.</small>
          </div>
        </div>
        <div className="hwb-actions">
          <span>{changed ? "Unsaved changes" : "Settings saved locally"}</span>
          {changed && (
            <button type="button" className="hwb-secondary" disabled={busy !== null}
              onClick={() => {
                editedRef.current = false;
                setDraft(status.preferences);
                setError(""); setNotice("Edits discarded.");
              }}>Discard</button>
          )}
          <button type="button" className="hwb-primary"
            disabled={busy !== null || !changed || (draft.enabled && !hasDestination)}
            onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save backup settings"}
          </button>
        </div>
      </section>

      <section className="hwb-panel" aria-labelledby="hwb-now-title">
        <div className="hwb-heading">
          <div>
            <h2 id="hwb-now-title">Backup management</h2>
            <p>Back up anytime, even when automatic backups are disabled.
              Manual backups do not reset your automatic schedule.</p>
          </div>
          <button type="button" className="hwb-primary"
            disabled={!ready} onClick={() => void runBackup()}>
            {busy === "backup" ? "Creating & verifying…" : "Back Up Now"}
          </button>
        </div>
        <div className="hwb-stats">
          <div><small>Last successful backup</small>
            <strong>{when(status.lastSuccessUnix)}</strong></div>
          <div><small>Next scheduled backup</small>
            <strong>{draft.enabled ? when(status.nextDueUnix) : "Disabled"}</strong></div>
          <div><small>Most recent backup size</small>
            <strong>{status.history[0] ?
              formattedBytes(status.history[0].bytes) : "No backups yet"}</strong></div>
        </div>
        {busy === "backup" && <p role="status" className="hwb-info">
          Copying and checking your backup. Wallpaper and settings operations may
          briefly pause until the snapshot finishes.</p>}
        {status.lastError && <p className="hwb-warning" role="status">
          Last backup warning: {status.lastError}</p>}
        <h3>Recent successful backups</h3>
        {status.history.length === 0 ? (
          <p className="hwb-muted">No backups created yet.</p>
        ) : (
          <div className="hwb-history">
            {status.history.map((entry) => (
              <div className="hwb-record" key={entry.path}>
                <div>
                  <strong>{entry.kind === "full" ? "Full Library" : "Settings"}</strong>
                  <small title={entry.path}>{entry.name}</small>
                </div>
                <div>
                  <span>{new Date(entry.createdUnix * 1000).toLocaleString()}</span>
                  <small>{formattedBytes(entry.bytes)} · {entry.fileCount} files</small>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="hwb-muted">Backups are verified folders ending in <code>.hwbackup</code>.
          Full backups contain the SQLite database and managed Library originals;
          temporary caches, browser profiles and Windows-bound API credentials are excluded.</p>
      </section>
      <section className="hwb-panel" aria-labelledby="hwb-restore-title">
        <div className="hwb-heading">
          <div>
            <h2 id="hwb-restore-title">Restore from a backup</h2>
            <p>Backup inspection, preview, Merge and Replace will be added in
              PR #11 Commit 2, after backup creation is tested.</p>
          </div>
          <button type="button" className="hwb-secondary" disabled>Restore…</button>
        </div>
        <p className="hwb-muted">No restore operations are enabled in this commit.
          Keep your generated backup folders safe for the next step.</p>
      </section>
      {error && <p className="hwb-error" role="alert">{error}</p>}
      {notice && <p className="hwb-success" role="status">{notice}</p>}
    </div>
  );
}
