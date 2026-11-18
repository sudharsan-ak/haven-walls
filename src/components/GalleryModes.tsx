import { useState, type FormEvent } from "react";
import type { CatalogSourceId } from "../lib/native";
import {
  DEFAULT_TAB_LABELS, readGalleryTabLabels, writeGalleryTabLabels,
  type RenameableTab,
} from "../lib/interestProfiles";
import "./GalleryModes.css";

interface Props {
  source: CatalogSourceId;
  onSourceChange: (value: CatalogSourceId) => void;
}
const MODES: { id: CatalogSourceId; fallback: string }[] = [
  { id: "discover", fallback: "Discover" },
  { id: "sports", fallback: "Sports Interests" },
  { id: "tmdb", fallback: "TV & Movies" },
  { id: "google", fallback: "Google Images" },
  { id: "bing", fallback: "Bing Daily" },
];

export default function GalleryModes({ source, onSourceChange }: Props) {
  const [labels, setLabels] = useState(readGalleryTabLabels);
  const [draft, setDraft] = useState({ ...labels });
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");

  function openEditor() {
    setDraft({ ...labels });
    setMessage("");
    setEditing(true);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = { ...DEFAULT_TAB_LABELS };
    for (const key of Object.keys(next) as RenameableTab[]) {
      const name = draft[key].trim();
      if (!name || name.length > 28 || /[<>\n\r]/.test(name)) {
        setMessage("Use a name between 1 and 28 characters."); return;
      }
      next[key] = name;
    }
    const allNames = [...Object.values(next), "Google Images", "Bing Daily"];
    if (new Set(allNames.map((s) => s.toLowerCase())).size !== allNames.length) {
      setMessage("Each tab must have a different name."); return;
    }
    try {
      writeGalleryTabLabels(next);
      setLabels(next);
      setEditing(false);
    } catch {
      setMessage("Could not save tab labels on this device.");
    }
  }

  return (
    <>
      <div className="hwgm-heading">
        <div className="eyebrow">Online wallpaper discovery</div>
        <h1>Explore wallpapers</h1>
        <p className="subheading">Search saved interests across your chosen sources,
          inspect images, and save the ones you want.</p>
      </div>
      <div className="hwgm-bar">
        <nav className="hwgm-tabs" aria-label="Gallery discovery modes">
          {MODES.map((item) => (
            <button type="button" key={item.id}
              aria-current={source === item.id ? "page" : undefined}
              className={source === item.id ? "active" : ""}
              onClick={() => onSourceChange(item.id)}>
              {item.id === "discover" || item.id === "sports" || item.id === "tmdb"
                ? labels[item.id] : item.fallback}
            </button>
          ))}
        </nav>
        <button type="button" className="hwgm-rename" onClick={openEditor}>
          ✎ Rename tabs
        </button>
      </div>
      {editing && (
        <div className="hwgm-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEditing(false);
        }}>
          <form role="dialog" aria-modal="true" aria-label="Rename Gallery tabs"
            className="hwgm-dialog" onSubmit={save}>
            <h2>Rename Gallery tabs</h2>
            <p>Only display names change. Interest types and searches stay linked to
              the same categories.</p>
            {(Object.keys(DEFAULT_TAB_LABELS) as RenameableTab[]).map((key) => (
              <label key={key}>
                {DEFAULT_TAB_LABELS[key]}
                <input type="text" maxLength={28} value={draft[key]}
                  onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.value }))}/>
              </label>
            ))}
            {message && <p role="alert" className="hwgm-error">{message}</p>}
            <div className="hwgm-actions">
              <button type="button" onClick={() => setDraft({ ...DEFAULT_TAB_LABELS })}>
                Restore defaults
              </button>
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit" className="hwgm-save">Save names</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
