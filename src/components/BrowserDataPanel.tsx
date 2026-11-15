import { useEffect, useState, type FormEvent } from "react";
import {
  browserAddBookmark, browserRemoveBookmark, browserClearHistory,
  type BrowserBookmark, type BrowserVisit,
} from "../lib/browserNative";
import "./BrowserDataPanel.css";

type Mode = "bookmarks" | "history" | "save";
interface Props {
  mode: Mode;
  current: { url: string; title: string };
  bookmarks: BrowserBookmark[];
  history: BrowserVisit[];
  onBookmarks: (list: BrowserBookmark[]) => void;
  onHistory: (list: BrowserVisit[]) => void;
  onOpen: (url: string, newTab: boolean) => void;
  onClose: () => void;
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default function BrowserDataPanel({
  mode, current, bookmarks, history, onBookmarks, onHistory, onOpen, onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(mode === "save");
  const [url, setUrl] = useState(current.url);
  const [title, setTitle] = useState(current.title);
  const [folder, setFolder] = useState("Favorites");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reset transient form state when the user switches panels or visits a new
  // website; saved bookmarks and history remain in native SQLite.
  useEffect(() => {
    const existing = bookmarks.find((item) => item.url === current.url);
    setSearch("");
    setEditing(mode === "save");
    setUrl(current.url);
    setTitle(existing?.title || current.title);
    setFolder(existing?.folder || "Favorites");
    setError("");
  }, [mode, current.url]);

  function edit(item: BrowserBookmark) {
    setUrl(item.url);
    setTitle(item.title);
    setFolder(item.folder);
    setEditing(true);
    setError("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !url || !title.trim()) return;
    setBusy(true);
    try {
      onBookmarks(await browserAddBookmark(url, title.trim(), folder.trim()));
      if (mode === "save") onClose();
      else setEditing(false);
      setError("");
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: number) {
    if (busy) return;
    setBusy(true);
    try {
      onBookmarks(await browserRemoveBookmark(id));
      setError("");
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }
  async function clearHistory() {
    if (busy) return;
    setBusy(true);
    try {
      await browserClearHistory();
      onHistory([]);
      setError("");
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLowerCase();
  const visibleBookmarks = bookmarks.filter((item) =>
    (item.title + " " + item.folder + " " + item.url).toLowerCase().includes(needle));
  const visibleHistory = history.filter((item) =>
    (item.title + " " + item.url).toLowerCase().includes(needle));
  const folders = [...new Set(["Favorites", ...bookmarks.map((item) => item.folder)])];

  return (
    <div className="hw-saved" role="dialog" aria-label="Saved browser data">
      <div className="hw-saved-heading">
        <div>
          <strong>{editing ? "Save bookmark" : mode === "history" ? "Browsing history" : "Bookmarks"}</strong>
          <small>{editing ? "Organize website bookmarks into folders"
            : "Saved locally in Haven Walls"}</small>
        </div>
        <button type="button" aria-label="Close panel" onClick={onClose}>×</button>
      </div>
      {error && <p className="hw-saved-error" role="alert">{error}</p>}
      {editing ? (
        <form className="hw-saved-form" onSubmit={(event) => void save(event)}>
          <label>Website<input value={url} readOnly/></label>
          <label>Bookmark title<input value={title} maxLength={180}
            onChange={(event) => setTitle(event.target.value)}/></label>
          <label>Folder<input value={folder} maxLength={60} list="hw-saved-folders"
            onChange={(event) => setFolder(event.target.value)}/></label>
          <datalist id="hw-saved-folders">
            {folders.map((name) => <option key={name} value={name}/>)}
          </datalist>
          <div className="hw-saved-form-actions">
            {mode !== "save" && <button type="button" onClick={() => setEditing(false)}>Back</button>}
            <button className="hw-saved-primary" disabled={busy || !title.trim()} type="submit">
              {busy ? "Saving…" : "Save bookmark"}
            </button>
          </div>
          <small>After saving, use the Bookmarks button to view your folders.</small>
        </form>
      ) : (
        <>
          <div className="hw-saved-search">
            <input type="search" placeholder={mode === "history" ? "Search history" : "Search bookmarks"}
              value={search} onChange={(event) => setSearch(event.target.value)}/>
            {mode === "history" && history.length > 0 &&
              <button type="button" disabled={busy} onClick={() => void clearHistory()}>Clear history</button>}
          </div>
          <div className="hw-saved-list">
            {mode === "bookmarks" && (visibleBookmarks.length
              ? visibleBookmarks.map((item) => (
                <div className="hw-saved-item" key={item.id}>
                  <button className="hw-saved-visit" type="button" onClick={() => onOpen(item.url, false)}>
                    <strong>{item.title}</strong><small>{item.folder} · {item.url}</small>
                  </button>
                  <button type="button" title="Open in new tab" onClick={() => onOpen(item.url, true)}>↗</button>
                  <button type="button" title="Edit bookmark" onClick={() => edit(item)}>✎</button>
                  <button type="button" title="Remove bookmark" disabled={busy}
                    onClick={() => void remove(item.id)}>×</button>
                </div>
              )) : <p className="hw-saved-empty">No matching bookmarks. Use ☆ to save this website.</p>)}
            {mode === "history" && (visibleHistory.length
              ? visibleHistory.map((item) => (
                <div className="hw-saved-item" key={item.id}>
                  <button className="hw-saved-visit" type="button" onClick={() => onOpen(item.url, false)}>
                    <strong>{item.title}</strong><small>{item.visitedAt} · {item.url}</small>
                  </button>
                  <button type="button" title="Open in new tab" onClick={() => onOpen(item.url, true)}>↗</button>
                </div>
              )) : <p className="hw-saved-empty">No matching browser history yet.</p>)}
          </div>
        </>
      )}
    </div>
  );
}
