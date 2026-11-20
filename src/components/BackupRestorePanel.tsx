import { useState } from "react";
import {
  chooseBackupFolder, previewBackupRestore, restoreBackup,
  type BackupRecord, type RestoreMode, type RestorePreview, type RestoreResult,
} from "../lib/backup";
import { formattedBytes } from "../lib/configuration";
import "./BackupRestorePanel.css";

interface Props {
  history: BackupRecord[];
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export default function BackupRestorePanel({ history }: Props) {
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [mode, setMode] = useState<RestoreMode>("merge");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"browse" | "inspect" | "restore" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RestoreResult | null>(null);

  function changePath(next: string) {
    setPath(next);
    setPreview(null);
    setResult(null);
    setConfirmation("");
    setError("");
  }
  async function browse() {
    if (busy) return;
    setBusy("browse");
    setError("");
    try {
      const selected = await chooseBackupFolder();
      if (selected !== null) changePath(selected);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  }
  async function inspect() {
    if (!path.trim() || busy) return;
    setBusy("inspect");
    setError("");
    setPreview(null);
    setResult(null);
    setConfirmation("");
    try {
      const details = await previewBackupRestore(path.trim());
      setPreview(details);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  }
  async function restore() {
    if (!preview || busy || (mode === "replace" && confirmation !== "RESTORE")) return;
    setBusy("restore");
    setError("");
    setResult(null);
    try {
      const restored = await restoreBackup(preview, mode);
      setResult(restored);
      setPreview(null);
      setConfirmation("");
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  }
  return (
    <section className="hwb-panel hwb-restore-panel" aria-labelledby="hwb-restore-title">
      <div className="hwb-heading">
        <div>
          <h2 id="hwb-restore-title">Restore from a backup</h2>
          <p>Inspect a verified Haven Walls backup before restoring.
            We make a complete local recovery snapshot before changing any saved data.</p>
        </div>
      </div>
      <div className="hwb-field">
        <label htmlFor="hwb-restore-folder">Backup folder (.hwbackup)</label>
        <div className="hwb-restore-path">
          <input id="hwb-restore-folder" spellCheck={false} value={path}
            placeholder="Select a HavenWalls-… .hwbackup folder"
            disabled={busy !== null}
            onChange={(event) => changePath(event.target.value)} />
          <button type="button" className="hwb-secondary" disabled={busy !== null}
            onClick={() => void browse()}>Browse…</button>
          <button type="button" className="hwb-secondary"
            disabled={busy !== null || !path.trim()}
            onClick={() => void inspect()}>
            {busy === "inspect" ? "Verifying…" : "Inspect backup"}
          </button>
        </div>
        <small>Select the actual backup folder, not its parent directory.
          Browsing or inspecting does not change your current Library.</small>
      </div>
      {history.length > 0 && !preview && (
        <div className="hwb-recent-restore">
          <span>Recent backups:</span>
          {history.slice(0, 3).map((item) => (
            <button type="button" className="hwb-recent-button" key={item.path}
              disabled={busy !== null} onClick={() => changePath(item.path)}
              title={item.path}>
              {item.kind === "full" ? "Full Library" : "Settings"} · {new Date(item.createdUnix*1000).toLocaleString()}
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="hwb-restore-preview">
          <div className="hwb-restore-preview-heading">
            <strong>Verified backup</strong>
            <span>SHA-256 checked</span>
          </div>
          <div className="hwb-restore-stats">
            <div><small>Created</small><strong>{new Date(preview.createdUnix*1000).toLocaleString()}</strong></div>
            <div><small>Type</small><strong>{preview.kind === "full" ? "Full Library + Settings" : "Settings only"}</strong></div>
            <div><small>Size</small><strong>{formattedBytes(preview.bytes)}</strong></div>
            <div><small>Saved images</small><strong>{preview.imageCount}</strong></div>
            <div><small>Collections</small><strong>{preview.collectionCount}</strong></div>
            <div><small>Categories / interests</small><strong>{preview.categoryCount} / {preview.interestCount}</strong></div>
          </div>
          <p className="hwb-restore-warning">{preview.warning}</p>
          <fieldset className="hwb-restore-modes">
            <legend>How should Haven Walls apply this backup?</legend>
            <label>
              <input type="radio" name="hwb-restore-mode" checked={mode === "merge"}
                disabled={busy !== null} onChange={() => {
                  setMode("merge"); setConfirmation("");
                }}/>
              <span><strong>Merge</strong><small>Keep current wallpapers and add any saved items from this backup.
                Existing entries and names are kept when they match.</small></span>
            </label>
            <label>
              <input type="radio" name="hwb-restore-mode" checked={mode === "replace"}
                disabled={busy !== null} onChange={() => setMode("replace")}/>
              <span><strong>Replace</strong><small>Use saved settings and interests from the backup.
                For a full backup, replace managed Library records and collection assignments.
                Existing image files are not deleted, and a recovery copy is kept.</small></span>
            </label>
          </fieldset>
          {mode === "replace" && (
            <div className="hwb-restore-confirm">
              <label htmlFor="hwb-restore-confirmation">To confirm replacement, type <strong>RESTORE</strong></label>
              <input id="hwb-restore-confirmation" autoComplete="off"
                value={confirmation} disabled={busy !== null}
                onChange={(event) => setConfirmation(event.target.value)} />
            </div>
          )}
          <div className="hwb-restore-actions">
            <button type="button" className="hwb-secondary"
              onClick={() => setPreview(null)} disabled={busy !== null}>Cancel</button>
            <button type="button" className={mode === "replace" ? "hwb-replace" : "hwb-primary"}
              disabled={busy !== null || (mode === "replace" && confirmation !== "RESTORE")}
              onClick={() => void restore()}>
              {busy === "restore" ? "Restoring and verifying…" :
                mode === "replace" ? "Replace from backup" : "Merge from backup"}
            </button>
          </div>
        </div>
      )}
      {busy === "restore" && <p role="status" className="hwb-info">
        Restoring your saved data. Do not close Haven Walls or disconnect the backup drive.</p>}
      {result && <div className="hwb-restore-finished" role="status">
        <strong>Restore complete</strong>
        <p>{result.notice}</p>
        <p>Managed image entries processed: {result.restoredImages}</p>
        <small>Independent recovery snapshot: {result.recoveryPath}</small>
      </div>}
      {error && <p role="alert" className="hwb-error">{error}</p>}
    </section>
  );
}
