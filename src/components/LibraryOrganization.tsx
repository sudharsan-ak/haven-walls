import { useState, type FormEvent } from "react";
import {
  createGroup, deleteGroup, groupIdsForImage, renameGroup,
  saveWallpaperOrganization,
  type NamedGroup, type OrganizationKind, type PersonalizationSnapshot,
} from "../lib/personalization";
import type { LibraryWallpaper } from "../lib/wallpaperLibrary";
import ConfirmDialog from "./ConfirmDialog";
import "./LibraryOrganization.css";

interface PanelProps {
  snapshot: PersonalizationSnapshot | null;
  wallpapers: LibraryWallpaper[];
  loading: boolean;
  error: string;
  selectedCollectionId: string | null;
  selectedCategoryId: string | null;
  onSelectCollection: (id: string | null) => void;
  onSelectCategory: (id: string | null) => void;
  onChanged: () => void;
}

type Target = { kind: OrganizationKind; group: NamedGroup };

function describe(kind: OrganizationKind) {
  return kind === "collection" ? "collection" : "category";
}

/** Library organization is separate from Gallery discovery/search topics. */
export default function LibraryOrganization({
  snapshot, wallpapers, loading, error, selectedCollectionId, selectedCategoryId,
  onSelectCollection, onSelectCategory, onChanged,
}: PanelProps) {
  const [names, setNames] = useState({ collection: "", category: "" });
  const [editing, setEditing] = useState<Target | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  async function add(kind: OrganizationKind, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await createGroup(kind, names[kind]);
      setNames((current) => ({ ...current, [kind]: "" }));
      setNotice("Created " + describe(kind) + ".");
      onChanged();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function updateName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await renameGroup(editing.kind, editing.group.id, editName);
      setEditing(null);
      setNotice("Name updated.");
      onChanged();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await deleteGroup(deleting.kind, deleting.group.id);
      if (deleting.kind === "collection" && selectedCollectionId === deleting.group.id) {
        onSelectCollection(null);
      }
      if (deleting.kind === "category" && selectedCategoryId === deleting.group.id) {
        onSelectCategory(null);
      }
      setNotice("Deleted " + describe(deleting.kind) + ". Saved wallpapers were not deleted.");
      setDeleting(null);
      onChanged();
    } catch (problem) {
      setActionError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  function section(kind: OrganizationKind) {
    const groups = snapshot?.collections ?? [];
    const links = snapshot?.wallpaperCollections ?? [];
    return (
      <div className="hwo-collection-section" key={kind}>
        <div className="hwo-collection-top">
          <span>{groups.length} {groups.length === 1 ? "collection" : "collections"}</span>
          <form className="hwo-add" onSubmit={(event) => void add("collection", event)}>
            <label htmlFor="hwo-add-collection" className="hwo-sr">New collection name</label>
            <input id="hwo-add-collection" type="text" maxLength={60}
              placeholder="New collection…" value={names.collection}
              disabled={busy || loading}
              onChange={(event) => setNames((old) => ({ ...old, collection: event.target.value }))}/>
            <button type="submit" disabled={busy || loading || !names.collection.trim()}>
              + Create collection
            </button>
          </form>
        </div>
        {groups.length === 0 && <p className="hwo-muted">No collections yet. Create one, then add
          saved wallpapers using the image's Collections action in the Wallpapers tab.</p>}
        <div className="hwo-collection-cards">
          {groups.map((group) => {
            const ids = new Set(links.filter((link) => link.groupId === group.id)
              .map((link) => link.wallpaperId));
            const photos = wallpapers.filter((image) => ids.has(image.id)).slice(0, 3);
            return (
              <article key={group.id} className="hwo-collection-card">
                <div className="hwo-collection-thumbs">
                  {photos.map((image) => <div key={image.id}>
                    {image.thumbnailDataUrl && <img src={image.thumbnailDataUrl}
                      alt="" loading="lazy"/>}
                  </div>)}
                  {Array.from({ length: 3 - photos.length }, (_, i) =>
                    <div key={"empty-" + i} className="hwo-collection-thumb-empty">▧</div>)}
                </div>
                <div className="hwo-collection-card-body">
                  <strong>{group.name}</strong>
                  <small>{ids.size} saved {ids.size === 1 ? "wallpaper" : "wallpapers"}</small>
                  <div className="hwo-collection-card-actions">
                    <button type="button" onClick={() => onSelectCollection(group.id)}>
                      View wallpapers
                    </button>
                    <button type="button" disabled={busy}
                      onClick={() => { setActionError(""); setEditing({ kind, group }); setEditName(group.name); }}>
                      Rename
                    </button>
                    <button type="button" disabled={busy} className="danger"
                      onClick={() => { setActionError(""); setDeleting({ kind, group }); }}>
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section className="hwo-panel" aria-label="Saved wallpaper collections">
      <div className="hwo-heading">
        <div>
          <h2>Saved wallpaper collections</h2>
          <p>Create personal groups for your saved images. A wallpaper can belong to more than one collection without making copies.</p>
        </div>
      </div>
      {loading && <p role="status" className="hwo-muted">Loading organization…</p>}
      {error && <p role="alert" className="hwo-error">{error}</p>}
      {snapshot && (
        <div className="hwo-panels">
          {section("collection")}
        </div>
      )}
      {notice && <p role="status" className="hwo-notice">{notice}</p>}
      {actionError && <p role="alert" className="hwo-error">{actionError}</p>}

      {editing && (
        <div className="hwo-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setEditing(null);
        }}>
          <form className="hwo-dialog" onSubmit={(event) => void updateName(event)}
            role="dialog" aria-modal="true" aria-label={"Rename " + editing.kind}>
            <h3>Rename {editing.kind}</h3>
            <label htmlFor="hwo-rename">Name</label>
            <input id="hwo-rename" autoFocus type="text" maxLength={60}
              value={editName} disabled={busy}
              onChange={(event) => setEditName(event.target.value)} />
            {actionError && <p role="alert" className="hwo-error">{actionError}</p>}
            <div className="hwo-dialog-actions">
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" disabled={busy || !editName.trim()}>Save</button>
            </div>
          </form>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title={"Delete " + deleting.group.name + "?"}
          description={"This removes the " + deleting.kind +
            " and its wallpaper associations, but keeps every saved wallpaper."}
          confirmLabel={"Delete " + deleting.kind}
          tone="danger" busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

interface EditorProps {
  image: LibraryWallpaper;
  snapshot: PersonalizationSnapshot;
  onClose: () => void;
  onSaved: () => void;
}

export function WallpaperOrganizationEditor({ image, snapshot, onClose, onSaved }: EditorProps) {
  // Preserve legacy wallpaper category labels while this screen moves to
  // discovery-oriented categories. The user only edits collection membership.
  const [categories] = useState<string[]>(
    () => groupIdsForImage(snapshot.wallpaperCategories, image.id)
  );
  const [collections, setCollections] = useState<string[]>(
    () => groupIdsForImage(snapshot.wallpaperCollections, image.id)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: string) {
    setCollections((current) => current.includes(id)
      ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveWallpaperOrganization(image.id, categories, collections);
      onSaved();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hwo-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <form className="hwo-dialog hwo-editor" role="dialog" aria-modal="true"
        aria-label={"Collections for " + image.title} onSubmit={(event) => void save(event)}>
        <h3>Manage wallpaper collections</h3>
        <p title={image.title}>{image.title}</p>
        <fieldset>
          <legend>Collections</legend>
          {snapshot.collections.length === 0 && (
            <small>No collections yet. Create one in Library → Collections.</small>
          )}
          <div className="hwo-editor-grid">
            {snapshot.collections.map((group) => (
              <label key={group.id} className="hwo-check">
                <input type="checkbox" checked={collections.includes(group.id)}
                  disabled={busy} onChange={() => toggle(group.id)} />
                <span>{group.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="hwo-error">{error}</p>}
        <div className="hwo-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save collections"}
          </button>
        </div>
      </form>
    </div>
  );
}
