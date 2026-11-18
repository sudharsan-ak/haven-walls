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
  snapshot, loading, error, selectedCollectionId, selectedCategoryId,
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
    const groups = kind === "collection" ? snapshot?.collections ?? [] : snapshot?.categories ?? [];
    const links = kind === "collection" ?
      snapshot?.wallpaperCollections ?? [] : snapshot?.wallpaperCategories ?? [];
    const activeId = kind === "collection" ? selectedCollectionId : selectedCategoryId;
    const onSelect = kind === "collection" ? onSelectCollection : onSelectCategory;
    return (
      <div className="hwo-group" key={kind}>
        <header className="hwo-group-title">
          <strong>{kind === "collection" ? "Collections" : "Categories"}</strong>
          <small>{kind === "collection" ?
            "Personal groups for your saved wallpapers" :
            "Labels that can overlap across images"}</small>
        </header>
        <div className="hwo-chips" role="group" aria-label={"Filter by " + kind}>
          <button type="button" className={"hwo-chip" + (activeId === null ? " active" : "")}
            aria-pressed={activeId === null} onClick={() => onSelect(null)}>
            All
          </button>
          {groups.map((group) => (
            <div className="hwo-chip-set" key={group.id}>
              <button type="button"
                aria-pressed={activeId === group.id}
                className={"hwo-chip" + (activeId === group.id ? " active" : "")}
                onClick={() => onSelect(activeId === group.id ? null : group.id)}
                title={"Show wallpapers in " + group.name}>
                {group.name}
                <span>{links.filter((link) => link.groupId === group.id).length}</span>
              </button>
              <button type="button" className="hwo-chip-edit"
                title={"Rename " + group.name} aria-label={"Rename " + group.name}
                disabled={busy}
                onClick={() => { setActionError(""); setEditing({ kind, group }); setEditName(group.name); }}>
                ✎
              </button>
              <button type="button" className="hwo-chip-remove"
                title={"Delete " + group.name} aria-label={"Delete " + group.name}
                disabled={busy}
                onClick={() => { setActionError(""); setDeleting({ kind, group }); }}>
                ×
              </button>
            </div>
          ))}
        </div>
        <form className="hwo-add" onSubmit={(event) => void add(kind, event)}>
          <label htmlFor={"hwo-add-" + kind} className="hwo-sr">
            New {kind} name
          </label>
          <input id={"hwo-add-" + kind} type="text" maxLength={60}
            placeholder={"New " + kind + "…"} value={names[kind]} disabled={busy || loading}
            onChange={(event) => setNames((old) => ({ ...old, [kind]: event.target.value }))} />
          <button type="submit" disabled={busy || loading || !names[kind].trim()}>
            + Add
          </button>
        </form>
      </div>
    );
  }

  return (
    <section className="hwo-panel" aria-label="Wallpaper collections and categories">
      <div className="hwo-heading">
        <div>
          <h2>Collections & Categories</h2>
          <p>Create and manage groups without duplicating images. Select a group to open its wallpapers.</p>
        </div>
      </div>
      {loading && <p role="status" className="hwo-muted">Loading organization…</p>}
      {error && <p role="alert" className="hwo-error">{error}</p>}
      {snapshot && (
        <div className="hwo-panels">
          {section("collection")}
          {section("category")}
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
  const [categories, setCategories] = useState<string[]>(
    () => groupIdsForImage(snapshot.wallpaperCategories, image.id)
  );
  const [collections, setCollections] = useState<string[]>(
    () => groupIdsForImage(snapshot.wallpaperCollections, image.id)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: string, kind: OrganizationKind) {
    const current = kind === "category" ? categories : collections;
    const update = kind === "category" ? setCategories : setCollections;
    update(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
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
        aria-label={"Organize " + image.title} onSubmit={(event) => void save(event)}>
        <h3>Organize wallpaper</h3>
        <p title={image.title}>{image.title}</p>
        {(["collection", "category"] as const).map((kind) => {
          const groups = kind === "collection" ? snapshot.collections : snapshot.categories;
          const current = kind === "collection" ? collections : categories;
          return (
            <fieldset key={kind}>
              <legend>{kind === "collection" ? "Collections" : "Categories"}</legend>
              {groups.length === 0 && (
                <small>No {kind === "collection" ? "collections" : "categories"} yet.
                  Close this dialog to create one above.</small>
              )}
              <div className="hwo-editor-grid">
                {groups.map((group) => (
                  <label key={group.id} className="hwo-check">
                    <input type="checkbox" checked={current.includes(group.id)}
                      disabled={busy} onChange={() => toggle(group.id, kind)} />
                    <span>{group.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
        {error && <p role="alert" className="hwo-error">{error}</p>}
        <div className="hwo-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save assignments"}
          </button>
        </div>
      </form>
    </div>
  );
}
