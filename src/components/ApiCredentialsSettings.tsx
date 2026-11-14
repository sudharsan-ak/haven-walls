import { useEffect, useState } from "react";
import {
  getApiCredentialStatus, removeApiCredential, saveApiCredential,
  type ApiCredentialStatus, type ApiProvider,
} from "../lib/apiCredentials";
import "./ApiCredentialsSettings.css";

const PROVIDERS: { id: ApiProvider; title: string; detail: string }[] = [
  { id: "serpapi", title: "Google Images via SerpApi",
    detail: "Used for API Search and category suggestions. Browser Search needs no key." },
  { id: "unsplash", title: "Unsplash access key",
    detail: "Used for category discovery when enabled. Provider usage requirements apply." },
  { id: "tmdb", title: "TMDB API Read Access Token",
    detail: "Used for TV-show searches and original backdrops." },
];
type Drafts = Record<ApiProvider, string>;
const emptyDrafts = (): Drafts => ({ serpapi: "", unsplash: "", tmdb: "" });
const message = (problem: unknown) =>
  problem instanceof Error ? problem.message : String(problem);

/** A credential is submitted only on Save. The native layer encrypts it
 * before writing SQLite and never sends it back to React. This Settings
 * component only receives true/false configured flags.
 */
export default function ApiCredentialsSettings() {
  const [configured, setConfigured] = useState<ApiCredentialStatus | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(emptyDrafts);
  const [visible, setVisible] = useState<Record<ApiProvider, boolean>>({
    serpapi: false, unsplash: false, tmdb: false,
  });
  const [working, setWorking] = useState<ApiProvider | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ApiProvider | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    void getApiCredentialStatus()
      .then((result) => { if (mounted) setConfigured(result); })
      .catch((problem) => { if (mounted) setError(message(problem)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  async function save(provider: ApiProvider) {
    const value = drafts[provider].trim();
    if (working || value.length < 3) return;
    setWorking(provider);
    setError("");
    setNotice("");
    try {
      const result = await saveApiCredential(provider, value);
      setConfigured(result);
      setDrafts((old) => ({ ...old, [provider]: "" }));
      setVisible((old) => ({ ...old, [provider]: false }));
      setConfirmRemove(null);
      setNotice("API credential saved securely. It will be used automatically across searches and app rebuilds.");
    } catch (problem) {
      setError(message(problem));
    } finally {
      setWorking(null);
    }
  }

  async function remove(provider: ApiProvider) {
    if (working) return;
    setWorking(provider);
    setError("");
    setNotice("");
    try {
      const result = await removeApiCredential(provider);
      setConfigured(result);
      setDrafts((old) => ({ ...old, [provider]: "" }));
      setConfirmRemove(null);
      setNotice("Saved credential removed from Haven Walls.");
    } catch (problem) {
      setError(message(problem));
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="hws-settings-panel" aria-labelledby="hws-credentials-title">
      <div className="hws-settings-section-header">
        <div>
          <h2 id="hws-credentials-title">API credentials</h2>
          <p>Enter each provider key once. Saved keys are reused for Google Images,
            Unsplash and TMDB wherever those sources are available.</p>
        </div>
        <span className="hws-settings-live">Stored locally</span>
      </div>
      <p className="hws-credentials-explain">
        Credentials are encrypted using Windows DPAPI before being stored in the
        existing Haven Walls SQLite database. They survive app updates and rebuilds.
        Keys remain tied to your Windows user account; when moving the data to another
        PC or Windows account, enter them again.
      </p>
      {loading ? <p role="status" className="hws-credentials-feedback">Checking saved credentials…</p>
        : configured && (
          <div className="hws-credentials-list">
            {PROVIDERS.map(({ id, title, detail }) => (
              <div className="hws-credential" key={id}>
                <div className="hws-credential-heading">
                  <div>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </div>
                  <span className={"hws-credential-state " + (configured[id] ? "configured" : "")}>
                    {configured[id] ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="hws-credential-controls">
                  <input
                    type={visible[id] ? "text" : "password"}
                    value={drafts[id]}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={configured[id] ? "Enter a new key to replace saved credential" : "Paste API key or access token"}
                    aria-label={title}
                    disabled={working !== null}
                    onChange={(event) => {
                      setDrafts((old) => ({ ...old, [id]: event.target.value }));
                      setNotice("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void save(id);
                      }
                    }}
                  />
                  <button type="button" className="hws-credentials-secondary"
                    disabled={working !== null}
                    onClick={() => setVisible((old) => ({ ...old, [id]: !old[id] }))}>
                    {visible[id] ? "Hide" : "Show"}
                  </button>
                  <button type="button" className="hws-credentials-primary"
                    disabled={working !== null || drafts[id].trim().length < 3}
                    onClick={() => void save(id)}>
                    {working === id ? "Saving…" : configured[id] ? "Replace key" : "Save key"}
                  </button>
                </div>
                {configured[id] && (
                  <div className="hws-credentials-remove">
                    {confirmRemove === id ? (
                      <>
                        <span>Remove this saved key?</span>
                        <button type="button" disabled={working !== null}
                          onClick={() => void remove(id)}>Yes, remove</button>
                        <button type="button" disabled={working !== null}
                          onClick={() => setConfirmRemove(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" disabled={working !== null}
                        onClick={() => setConfirmRemove(id)}>Remove saved key</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      {error && <p className="hws-settings-error" role="alert">{error}</p>}
      {notice && !error && <p className="hws-settings-success" role="status">{notice}</p>}
      <p className="hws-credentials-footnote">
        Use each key's own Save button. The normal Save settings button below is for
        wallpaper preferences only. API keys are never shown again after saving.
      </p>
    </section>
  );
}
