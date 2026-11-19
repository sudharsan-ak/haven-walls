import { useEffect, useState, type ChangeEvent } from "react";
import {
  changeStorageMode, clearTemporaryCache, formattedBytes, getConfiguration,
  migrateLegacyDisplaySettings, saveConfiguration,
  type AppSettings, type ConfigurationSnapshot, type StorageMode,
  type WallpaperFit, type MinimumResolution,
} from "../lib/configuration";
import "./SettingsPage.css";
import ConfirmDialog from "./ConfirmDialog";
import ApiCredentialsSettings from "./ApiCredentialsSettings";
import AutomationSettings from "./AutomationSettings";

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

export type SettingsTab = "wallpaper" | "automation" | "library" | "sources" | "storage";
interface SettingsPageProps {
  selectedTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onBrowseWallpapers: () => void;
  onOpenLibrary: () => void;
  onOpenCollections: () => void;
}
const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "wallpaper", label: "Wallpaper & Display" },
  { key: "automation", label: "Automation" },
  { key: "library", label: "Library & Quality" },
  { key: "sources", label: "Sources" },
  { key: "storage", label: "Storage & Privacy" },
];
export default function SettingsPage({
  selectedTab, onTabChange, onBrowseWallpapers, onOpenLibrary, onOpenCollections,
}: SettingsPageProps) {
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [storageChoice, setStorageChoice] = useState<StorageMode>("appData");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<"move" | "cache" | null>(null);

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
    setError("");
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
      <div className="eyebrow">Haven Walls / Preferences</div>
      <h1>Settings</h1>
      <p className="subheading">Your wallpaper, rotation and storage preferences in one place. Everything stays local.</p>


      <nav className="hws-settings-tabs" role="tablist" aria-label="Settings categories">
        {SETTINGS_TABS.map((tab) => (
          <button key={tab.key} type="button" role="tab"
            id={"hws-tab-" + tab.key}
            aria-selected={selectedTab === tab.key}
            aria-controls={"hws-panel-" + tab.key}
            className={selectedTab === tab.key ? "selected" : ""}
            onClick={() => onTabChange(tab.key)}>{tab.label}</button>
        ))}
      </nav>
      {(changed || error || notice) && (
        <div className={"hws-settings-feedback" + (changed ? " has-changes" :
          error ? " has-error" : " is-saved")}
          role={error ? "alert" : "status"} aria-live="polite">
          <div>
            <strong>{error ? "Could not save changes" :
              changed ? "Unsaved changes" : "Settings updated"}</strong>
            <span>{error || (changed
              ? "Your edits are not saved until you select Save settings."
              : notice)}</span>
          </div>
          {changed && (
            <button type="button" className="hws-settings-primary"
              disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save changes"}
            </button>
          )}
        </div>
      )}
      {selectedTab === "wallpaper" && (
        <div id="hws-panel-wallpaper" role="tabpanel" aria-labelledby="hws-tab-wallpaper">
      <section className="hws-settings-panel" aria-labelledby="hws-wallpaper">
        <div className="hws-settings-section-header">
          <div>
            <h2 id="hws-wallpaper">Wallpaper & display</h2>
            <p>Defaults used by Set Now in Library and the Gallery import flow.</p>
          </div>
          <span className="hws-settings-live">Available now</span>
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
          <div><strong>Show photo credit</strong><small>Bottom-right overlay on prepared wallpaper copies. Original Library images are unchanged.</small></div>
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


        </div>
      )}
      {selectedTab === "automation" && (
        <div id="hws-panel-automation" role="tabpanel" aria-labelledby="hws-tab-automation">
          <AutomationSettings onBrowseWallpapers={onBrowseWallpapers}
            onOpenLibrary={onOpenLibrary} onOpenCollections={onOpenCollections} />
        </div>
      )}
      {selectedTab === "library" && (
        <div id="hws-panel-library" role="tabpanel" aria-labelledby="hws-tab-library">
      <section className="hws-settings-panel" aria-labelledby="hws-import">
        <div className="hws-settings-section-header">
          <div>
            <h2 id="hws-import">Library & importing</h2>
            <p>Choose how user-initiated wallpaper imports behave.</p>
          </div>
          <span className="hws-settings-live">Available now</span>
        </div>
        <label className="hws-settings-toggle">
          <div>
            <strong>Quick Save to Library</strong>
            <small>Skip the repeated confirmation dialog and begin saving when you click Add to Library. Enabled by default.</small>
          </div>
          <input type="checkbox" checked={form.skipImportConfirmation}
            onChange={(event) => field("skipImportConfirmation", event.target.checked)} />
        </label>
        <p className="hws-settings-note">
          Quick Save is a convenience setting. It does not verify or grant image
          usage rights. You are still responsible for following each image
          source's license and attribution requirements. Turn this off to
          require the individual confirmation before saving.
        </p>
      </section>


      <section className="hws-settings-panel" aria-labelledby="hws-quality">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-quality">Image quality & duplicate detection</h2>
            <p>Validated during every managed Library import. Exact duplicates always remain blocked.</p></div>
          <span className="hws-settings-live">Available now</span>
        </div>
        <label className="hws-settings-toggle">
          <div>
            <strong>Allow images below minimum resolution</strong>
            <small>Off by default. When enabled, smaller images can be saved to the Library with or without Quick Save. You can still override this choice for an individual import.</small>
          </div>
          <input type="checkbox" checked={form.allowBelowMinimum}
            onChange={(event) => field("allowBelowMinimum", event.target.checked)} />
        </label>
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


        </div>
      )}
      {selectedTab === "sources" && (
        <div id="hws-panel-sources" role="tabpanel" aria-labelledby="hws-tab-sources">
      <section className="hws-settings-panel" aria-labelledby="hws-exclusions">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-exclusions">Source & keyword exclusions</h2>
            <p>Applied when saving online discoveries to the Library. Search results themselves remain visible.</p></div>
          <span className="hws-settings-live">Available now</span>
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


      <ApiCredentialsSettings />


        </div>
      )}
      {selectedTab === "storage" && (
        <div id="hws-panel-storage" role="tabpanel" aria-labelledby="hws-tab-storage">
      <div className="hws-settings-summary">
        <div><span>Storage</span><strong>{snapshot.storage.mode === "appData" ? "Windows AppData" : "Portable folder"}</strong></div>
        <div><span>Cache limit</span><strong>{formattedBytes(form.cacheLimitMb * 1024 * 1024)}</strong></div>
        <div><span>Privacy</span><strong>Local only · No telemetry</strong></div>
      </div>


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
            <small>Default 2048 MB (2 GB). Reserved for disposable discovery previews. Managed wallpapers, favorites and active copies are never auto-evicted.</small>
          </label>
          <div className="hws-settings-field">
            <strong>Disposable discovery cache</strong>
            <button type="button" className="hws-settings-secondary" disabled={busy}
              onClick={() => setPendingAction("cache")}>Clear temporary cache</button>
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
              onClick={() => setPendingAction("move")}>
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


      <section className="hws-settings-panel" aria-labelledby="hws-privacy">
        <div className="hws-settings-section-header">
          <div><h2 id="hws-privacy">Privacy & appearance</h2>
            <p>Local-first by design. Future background behavior is not silently activated.</p></div>
        </div>
        <div className="hws-privacy-row"><strong>Telemetry</strong><span>Off · Not collected</span></div>
        <div className="hws-privacy-row"><strong>Automatic rotation</strong><span>Configure in the Automation tab</span></div>
        <div className="hws-privacy-row"><strong>Windows startup</strong><span>Opt-in from the Automation tab in the installed release. Global shortcuts planned.</span></div>
        <div className="hws-privacy-row"><strong>Dark appearance</strong><span>Planned; current light theme retained</span></div>
      </section>


        </div>
      )}
      {(selectedTab !== "automation" || changed) && (
        <>
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

        </>
      )}
      {pendingAction === "move" && (
        <ConfirmDialog tone="warning"
          title="Move Haven Walls storage?"
          description={"Copy the Library and database to " +
            (storageChoice === "portable" ? "the portable folder beside the EXE" : "Windows AppData") + "?"}
          note="The current storage location is kept as a recovery copy. Existing destination files are never overwritten."
          confirmLabel="Move storage"
          busy={busy}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            setPendingAction(null);
            void moveStorage();
          }} />
      )}
      {pendingAction === "cache" && (
        <ConfirmDialog tone="warning"
          title="Clear temporary image cache?"
          description={"Delete " + formattedBytes(snapshot.storage.discoveryBytes) +
            " of disposable discovery previews?"}
          note="Your saved Library wallpapers, active desktop copies and offline reserve are protected."
          confirmLabel="Clear temporary cache"
          busy={busy}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            setPendingAction(null);
            void clearCache();
          }} />
      )}

    </section>
  );
}
