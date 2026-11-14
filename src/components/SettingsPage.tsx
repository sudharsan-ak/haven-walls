import { useEffect, useState, type ChangeEvent } from "react";
import {
  changeStorageMode, clearTemporaryCache, formattedBytes, getConfiguration,
  migrateLegacyDisplaySettings, saveConfiguration,
  type AppSettings, type ConfigurationSnapshot, type StorageMode,
  type WallpaperFit, type MinimumResolution,
} from "../lib/configuration";
import "./SettingsPage.css";

const WALLPAPER_FITS: { value: WallpaperFit; label: string }[] = [
  { value: "smartFit", label: "Smart Fit (recommended)" },
  { value: "fill", label: "Fill" },
  { value: "fit", label: "Fit" },
  { value: "center", label: "Center" },
  { value: "stretch", label: "Stretch" },
  { value: "span", label: "Span across monitors" },
];
const IMAGE_TYPES = ["jpg", "png", "webp"] as const;

function statusMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsPage() {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [storageChoice, setStorageChoice] = useState<StorageMode>("appData");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getConfiguration()
      .then(migrateLegacyDisplaySettings)
      .then((result) => {
        if (cancelled) return;
        setSnapshot(result);
        setForm(result.settings);
        setStorageChoice(result.storage.mode);
      })
      .catch((problem) => {
        if (!cancelled) setError(statusMessage(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function field<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setForm((existing) => existing ? { ...existing, [key]: value } : existing);
    setNotice("");
  }

  const changed = Boolean(snapshot && form &&
    JSON.stringify(snapshot.settings) !== JSON.stringify(form));

  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveConfiguration(form);
      setSnapshot(result);
      setForm(result.settings);
      setNotice("Preferences saved to the Haven Walls SQLite database.");
    } catch (problem) {
      setError(statusMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  async function moveStorage() {
    if (!snapshot || busy || changed || storageChoice === snapshot.storage.mode) return;
    const destination = storageChoice === "portable"
      ? "the HavenWallsData folder alongside the EXE"
      : "Windows AppData";
    if (!window.confirm(
      "Move Haven Walls data to " + destination + "?\n\n" +
      "This copies the database and managed files without deleting the old location. " +
      "Existing data at the destination will not be overwritten."
    )) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await changeStorageMode(storageChoice);
      setSnapshot(result);
      setForm(result.settings);
      setStorageChoice(result.storage.mode);
      setNotice("Data copied to " + result.storage.rootPath +
        ". The old location was preserved as a recovery copy.");
    } catch (problem) {
      setError(statusMessage(problem));
      setStorageChoice(snapshot.storage.mode);
    } finally {
      setBusy(false);
    }
  }

  async function clearCache() {
    if (!snapshot || busy) return;
    const count = snapshot.storage.discoveryBytes;
    if (count === 0) {
      setNotice("Temporary discovery cache is already empty.");
      return;
    }
    if (!window.confirm(
      "Clear " + formattedBytes(count) + " of disposable discovery images?\n\n" +
      "Managed wallpapers, current wallpaper copies, pending approval, and offline reserve stay untouched."
    )) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await clearTemporaryCache();
      setSnapshot(result);
      setNotice("Disposable discovery cache cleared. Managed and active files were preserved.");
    } catch (problem) {
      setError(statusMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  function toggleImageType(event: ChangeEvent<HTMLInputElement>) {
    if (!form) return;
    const selected = event.target.value;
    const next = event.target.checked
      ? [...form.allowedImageTypes, selected]
      : form.allowedImageTypes.filter((type) => type !== selected);
    field("allowedImageTypes", next);
  }

  if (loading) {
    return <section className="hws-settings-page">
      <div className="eyebrow">Local configuration</div>
      <h1>Settings</h1>
      <div className="hws-settings-loading" role="status">Opening local storage and settings…</div>
    </section>;
  }
  if (!snapshot || !form) {
    return <section className="hws-settings-page">
      <div className="eyebrow">Local configuration</div>
      <h1>Settings</h1>
      <p className="hws-settings-error" role="alert">{error || "Settings are unavailable."}</p>
      <p className="subheading">Haven Walls needs its Windows native host for local storage.</p>
    </section>;
  }

  return (
    <section className="hws-settings-page">
      <div className="eyebrow">Haven Walls / Settings</div>
      <h1>Settings</h1>
      <p className="subheading">
        Your preferences are stored locally. The library and Windows wallpaper integration
        will use them in the next PR #3 commits.
      </p>

      <div className="hws-settings-summary">
        <div><span>Storage</span><strong>{snapshot.storage.mode === "appData" ? "Windows AppData" : "Portable folder"}</strong></div>
        <div><span>Cache limit</span><strong>{formattedBytes(form.cacheLimitMb * 1024 * 1024)}</strong></div>
        <div><span>Privacy</span><strong>Local only · No telemetry</strong></div>
      </div>

      <section className="hws-settings-panel" aria-labelledby="hws-wallpaper">
        <div className="hws-settings-section-header">
          <div>
            <h2 id="hws-wallpaper">Wallpaper & display</h2>
            <p>Saved defaults for the Windows wallpaper application work in this PR.</p>
          </div>
          <span className="hws-settings-phase">Used in next commit</span>
        </div>
        <div className="hws-settings-fields two">
          <label className="hws-settings-field">
            <strong>Default wallpaper fit</strong>
            <select value={form.wallpaperFit}
              onChange={(event) => field("wallpaperFit", event.target.value as WallpaperFit)}>
              {WALLPAPER_FITS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
            </select>
          </label>
          <label className="hws-settings-field">
            <strong>Minimum image resolution</strong>
            <select value={form.minimumResolution}
              onChange={(event) => field("minimumResolution", event.target.value as MinimumResolution)}>
              <option value="1080p">1080p (1920 × 1080)</option>
              <option value="1440p">1440p (2560 × 1440)</option>
              <option value="4K">4K (3840 × 2160)</option>
            </select>
          </label>
        </div>
        <label className="hws-settings-toggle">
          <div><strong>Prefer 4K when available</strong><small>Keep 1080p+ images eligible unless your minimum is set higher.</small></div>
          <input type="checkbox" checked={form.prefer4k}
            onChange={(event) => field("prefer4k", event.target.checked)} />
        </label>
        <label className="hws-settings-toggle">
          <div><strong>Show photo credit</strong><small>Optional bottom-right overlay. Source attribution stays in metadata even when hidden.</small></div>
          <input type="checkbox" checked={form.showPhotoCredit}
            onChange={(event) => field("showPhotoCredit", event.target.checked)} />
        </label>
        <label className="hws-settings-toggle">
          <div><strong>Show image caption</strong><small>Optional image title displayed on an applied wallpaper.</small></div>
          <input type="checkbox" checked={form.showCaption}
            onChange={(event) => field("showCaption", event.target.checked)} />
        </label>
        <p className="hws-settings-note">Attribution required by an image license cannot be disabled merely by hiding a visual credit.</p>
      </section>

      <section className="hws-settings-panel" aria-labelledby="hws-storage">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-storage">Storage & cache</h2>
            <p>Separate managed library, protected active files, and disposable discovery cache.</p></div>
          <span className="hws-settings-live">Available now</span>
        </div>
        <div className="hws-storage-totals">
          <div><span>Discovery cache</span><strong>{formattedBytes(snapshot.storage.discoveryBytes)}</strong></div>
          <div><span>Managed library</span><strong>{formattedBytes(snapshot.storage.managedBytes)}</strong></div>
          <div><span>Active copies</span><strong>{formattedBytes(snapshot.storage.activeBytes)}</strong></div>
          <div><span>Offline reserve</span><strong>{formattedBytes(snapshot.storage.offlineReserveBytes)}</strong></div>
          <div><span>Pending review</span><strong>{formattedBytes(snapshot.storage.pendingBytes)}</strong></div>
          <div><span>Database</span><strong>{formattedBytes(snapshot.storage.databaseBytes)}</strong></div>
        </div>
        <div className="hws-settings-fields two">
          <label className="hws-settings-field">
            <strong>Temporary cache limit (MB)</strong>
            <input type="number" min={128} max={20480} step={128} value={form.cacheLimitMb}
              onChange={(event) => field("cacheLimitMb", Number(event.target.value))}/>
            <small>Default 2048 MB (2 GB). Automatic limit enforcement arrives with the download/cache service.</small>
          </label>
          <div className="hws-settings-field">
            <strong>Disposable discovery cache</strong>
            <button type="button" className="hws-settings-secondary" disabled={busy}
              onClick={() => void clearCache()}>Clear temporary cache</button>
            <small>Does not touch managed, favorites, active or offline-reserve image files.</small>
          </div>
        </div>
        <div className="hws-storage-location">
          <strong>Where Haven Walls stores data</strong>
          <code title={snapshot.storage.rootPath}>{snapshot.storage.rootPath}</code>
          <div className="hws-storage-switch">
            <label><input name="storageMode" type="radio" value="appData"
              checked={storageChoice === "appData"}
              onChange={() => setStorageChoice("appData")}/> Windows AppData</label>
            <label><input name="storageMode" type="radio" value="portable"
              checked={storageChoice === "portable"}
              onChange={() => setStorageChoice("portable")}/> Portable folder beside EXE</label>
            <button type="button" className="hws-settings-secondary"
              disabled={busy || changed || storageChoice === snapshot.storage.mode}
              onClick={() => void moveStorage()}>
              Move storage
            </button>
          </div>
          <small>
            Haven Walls copies into a new, empty destination and keeps the old files as a
            recovery copy. Existing destination data is never overwritten. Storage moves
            are disabled until you save pending preference edits.
          </small>
        </div>
      </section>

      <section className="hws-settings-panel" aria-labelledby="hws-quality">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-quality">Image quality & duplicate detection</h2>
            <p>Configured now; validation and similarity matching are added with library imports.</p></div>
          <span className="hws-settings-phase">Used in next commit</span>
        </div>
        <label className="hws-settings-field">
          <strong>Allowed image types</strong>
          <div className="hws-image-types">
            {IMAGE_TYPES.map((type) =>
              <label key={type}>
                <input type="checkbox" value={type}
                  checked={form.allowedImageTypes.includes(type)}
                  onChange={toggleImageType}/>
                {type.toUpperCase()}
              </label>)}
          </div>
        </label>
        <label className="hws-settings-field">
          <strong>Similar-image sensitivity: {form.duplicateSensitivity}%</strong>
          <input type="range" min={0} max={100} step={5}
            value={form.duplicateSensitivity}
            onChange={(event) => field("duplicateSensitivity", Number(event.target.value))}/>
          <small>0 = permissive, 100 = strict. Exact-file deduplication is separate.</small>
        </label>
      </section>

      <section className="hws-settings-panel" aria-labelledby="hws-exclusions">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-exclusions">Source & keyword exclusions</h2>
            <p>Global exclusions for future eligible downloads. Current manual Google results are not filtered yet.</p></div>
          <span className="hws-settings-phase">Prepared for library</span>
        </div>
        <div className="hws-settings-fields two">
          <label className="hws-settings-field">
            <strong>Blocked keywords</strong>
            <textarea rows={4} value={form.excludedKeywords.join("\n")}
              onChange={(event) => field("excludedKeywords", event.target.value.split("\n"))}
              placeholder={"watermarked\nlow resolution"}/>
            <small>One keyword per line, up to 100.</small>
          </label>
          <label className="hws-settings-field">
            <strong>Blocked source names or domains</strong>
            <textarea rows={4} value={form.excludedSources.join("\n")}
              onChange={(event) => field("excludedSources", event.target.value.split("\n"))}
              placeholder={"example.com\nblocked-source"}/>
            <small>One entry per line. The rule engine will use these during import.</small>
          </label>
        </div>
      </section>

      <section className="hws-settings-panel" aria-labelledby="hws-privacy">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-privacy">Privacy, appearance & upcoming</h2>
            <p>Local-first by design. Future background behavior is not silently activated.</p></div>
        </div>
        <div className="hws-privacy-row"><strong>Telemetry</strong><span>Off · Not collected</span></div>
        <div className="hws-privacy-row"><strong>Automatic rotation and scheduling</strong><span>Not enabled yet</span></div>
        <div className="hws-privacy-row"><strong>Global shortcuts and startup tray</strong><span>Not enabled yet</span></div>
        <div className="hws-privacy-row"><strong>Dark appearance</strong><span>Planned; current light theme retained</span></div>
        <div className="hws-privacy-row"><strong>API credentials</strong><span>Session-only in current discovery screens</span></div>
      </section>

      <div className="hws-settings-actions">
        <div className="hws-settings-status" aria-live="polite">
          {error && <p role="alert" className="hws-settings-error">{error}</p>}
          {!error && notice && <p className="hws-settings-success">{notice}</p>}
          {!error && !notice && <p>{changed ? "Unsaved changes" : "All preferences saved locally"}</p>}
        </div>
        <button type="button" className="hws-settings-secondary"
          disabled={!changed || busy}
          onClick={() => { setForm(snapshot.settings); setError(""); setNotice("Edits discarded."); }}>
          Discard
        </button>
        <button type="button" className="hws-settings-primary"
          disabled={!changed || busy}
          onClick={() => void save()}>
          {busy ? "Working…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}
