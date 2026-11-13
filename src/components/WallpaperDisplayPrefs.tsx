import { useEffect, useState } from "react";
import {
  loadWallpaperDisplayPrefs,
  saveWallpaperDisplayPrefs,
} from "../lib/wallpaperDisplayPrefs";
import "./WallpaperDisplayPrefs.css";

/** Persisted settings ready for PR #3; no desktop overlay is applied in PR #2. */
export default function WallpaperDisplayPrefs() {
  const [prefs, setPrefs] = useState(loadWallpaperDisplayPrefs);
  const [saved, setSaved] = useState(true);
  useEffect(() => setSaved(saveWallpaperDisplayPrefs(prefs)), [prefs]);

  return (
    <section className="wdp-panel" aria-label="Future wallpaper caption and credit preferences">
      <div className="wdp-header">
        <div>
          <h2>Wallpaper photo information</h2>
          <p>These choices will be used when Haven Walls starts applying desktop wallpapers in PR #3.</p>
        </div>
        <span>PR #3</span>
      </div>
      <label className="wdp-option">
        <span><strong>Show photo credit</strong>
          <small>Bottom-right photo/source credit, where permitted</small></span>
        <input type="checkbox" checked={prefs.showPhotoCredit}
          onChange={(event) => setPrefs((value) => ({
            ...value, showPhotoCredit: event.target.checked,
          }))}/>
      </label>
      <label className="wdp-option">
        <span><strong>Show caption</strong>
          <small>Optional image title or description near the bottom of the wallpaper</small></span>
        <input type="checkbox" checked={prefs.showCaption}
          onChange={(event) => setPrefs((value) => ({
            ...value, showCaption: event.target.checked,
          }))}/>
      </label>
      <p className="wdp-foot">
        Source URL, photographer credit when available, and rights information stay in metadata
        even if display text is hidden. Some image licenses require attribution and must be
        honored separately. No Windows wallpaper changes happen in this PR.
      </p>
      {!saved && <p className="wdp-warning" role="alert">Couldn't save these preferences locally.</p>}
    </section>
  );
}
