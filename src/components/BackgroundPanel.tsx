import { useEffect, useState } from "react";
import { getBackgroundStatus, saveBackgroundSettings, type BackgroundStatus } from "../lib/background";
import "./RotationPage.css";

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
export default function BackgroundPanel() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void getBackgroundStatus().then((value) => {
      if (alive) setStatus(value);
    }).catch((reason: unknown) => {
      if (alive) setError(message(reason));
    });
    return () => { alive = false; };
  }, []);

  async function change(closeToTray: boolean, launchAtLogin: boolean) {
    if (busy || !status) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await saveBackgroundSettings(closeToTray, launchAtLogin);
      setStatus(next);
      setNotice("Background preferences saved.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hwr-background">
      <div>
        <h2>Background operation</h2>
        <p>The Rust scheduler can keep rotating your desktop after you close the window. Use the tray icon to reopen Haven Walls or quit it fully.</p>
      </div>
      {status && (
        <div className="hwr-background-options">
          <label>
            <input type="checkbox" checked={status.closeToTray} disabled={busy}
              onChange={(event) => void change(event.target.checked, status.launchAtLogin)} />
            <span><strong>Keep running in system tray</strong>
              <small>When rotation is on, Close hides the window instead of quitting. Disable rotation to restore normal closing behavior.</small>
            </span>
          </label>
          <label>
            <input type="checkbox" checked={status.launchAtLogin}
              disabled={busy || !status.startupAvailable}
              onChange={(event) => void change(status.closeToTray, event.target.checked)} />
            <span><strong>Start at Windows login</strong>
              <small>Optional, per-user startup. Starts hidden in the system tray, without opening the main window.
                {!status.startupAvailable && " Install and launch the release .exe to change this setting; it is unavailable in tauri dev."}
              </small>
            </span>
          </label>
        </div>
      )}
      {error && <p className="hwr-background-error" role="alert">{error}</p>}
      {notice && <p className="hwr-background-success" role="status">{notice}</p>}
    </section>
  );
}
