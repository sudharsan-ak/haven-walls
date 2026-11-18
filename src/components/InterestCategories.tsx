import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  removeFollowedInterest, saveFollowedInterest,
  type FollowedInterest, type InterestInput, type InterestKind,
  type PersonalizationSnapshot,
} from "../lib/personalization";
import {
  defaultInterestPreferences, familyForKind, INTEREST_TYPES,
  kindLabel, linkedWebsites, preferencesFor, type InterestPreferences,
  type WebsiteMode,
} from "../lib/interestProfiles";
import { normalizeLeagueWebsite } from "../lib/sportsLeagues";
import ConfirmDialog from "./ConfirmDialog";
import { browseWallpaperSource, type CatalogImage } from "../lib/native";
import "./InterestCategories.css";

interface Props {
  snapshot: PersonalizationSnapshot | null;
  loading: boolean;
  error: string;
  onChanged: () => void;
  onPreview: (interest: FollowedInterest) => void;
}
const ARTWORK = ["Teams", "Players", "Game action", "Logos", "Backdrops", "Posters",
  "Episode stills", "Landscapes", "Other"];
const WINDOW_OPTIONS = [
  ["day", "Past 24 hours"], ["week", "Past week"], ["month", "Past month"],
  ["year", "Past year"], ["any", "Any time"], ["custom", "Custom dates"],
] as const;

export default function InterestCategories({
  snapshot, loading, error, onChanged, onPreview,
}: Props) {
  const interests = useMemo(() => snapshot?.followedInterests ?? [], [snapshot]);
  const [selectedId, setSelectedId] = useState("");
  const selected = interests.find((item) => item.id === selectedId) ?? interests[0];
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<InterestPreferences | null>(null);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<InterestKind>("team");
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [providerMatches, setProviderMatches] = useState<CatalogImage[]>([]);
  const [providerChoice, setProviderChoice] = useState<CatalogImage | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [newWebsite, setNewWebsite] = useState("");
  const [newSiteMode, setNewSiteMode] = useState<WebsiteMode>("google");
  const [deleting, setDeleting] = useState<FollowedInterest | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setName(selected?.title ?? "");
    setDraft(selected ? preferencesFor(selected) : null);
    setProblem("");
    setNewWebsite("");
  }, [selected?.id, selected?.title, selected?.preferences]);

  function update<K extends keyof InterestPreferences>(key: K, value: InterestPreferences[K]) {
    setDraft((old) => old ? { ...old, [key]: value } : old);
    setNotice("");
  }

  function allowedParents(kind: InterestKind) {
    if (kind === "team") return interests.filter((item) => item.kind === "league");
    if (kind === "player") return interests.filter((item) => item.kind === "team");
    return [];
  }

  async function lookUpProvider() {
    if (!newName.trim() || lookupBusy || !["team", "tv"].includes(newType)) return;
    setLookupBusy(true);
    setProblem("");
    try {
      const response = await browseWallpaperSource(newType === "tv" ? "tmdb" : "sports",
        newName.trim());
      setProviderMatches(response.items.filter((item) =>
        newType === "tv" ? item.kind === "tv-show" : item.kind === "image"));
      if (response.items.length === 0) setProblem("No provider matches. You can still save a keyword-only interest.");
    } catch (reason) {
      setProblem("Provider lookup unavailable: " +
        (reason instanceof Error ? reason.message : String(reason)) +
        ". A custom interest can still use Google and saved websites.");
    } finally { setLookupBusy(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = (providerChoice?.title || newName).trim();
    if (!title || busy) return;
    if (interests.some((item) =>
      item.kind === newType && item.title.toLowerCase() === title.toLowerCase()
    )) {
      setProblem("This saved interest already exists.");
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const provider = providerChoice && newType === "tv" ? "tmdb" :
        providerChoice && newType === "team" ? "sportsdb" : "custom";
      const providerId = providerChoice
        ? (newType === "team" ? providerChoice.id.replace(/^sports-/, "") : providerChoice.id)
        : "custom-" + crypto.randomUUID();
      const input: InterestInput = {
        kind: newType, provider, providerId, title,
        parentId: allowedParents(newType).some((item) => item.id === newParent)
          ? newParent : null,
        preferences: defaultInterestPreferences(newType, title) as unknown as Record<string, unknown>,
      };
      await saveFollowedInterest(input);
      setCreating(false);
      setNewName("");
      setNewParent("");
      setProviderMatches([]);
      setProviderChoice(null);
      // Re-read to find the backend-generated stable ID for the new entry.
      setNewlyCreatedProviderId(providerId);
      setNotice("Saved interest created. It will appear in Gallery.");
      onChanged();
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }
  const [newlyCreatedProviderId, setNewlyCreatedProviderId] = useState("");
  useEffect(() => {
    if (!newlyCreatedProviderId) return;
    const found = interests.find((item) => item.providerId === newlyCreatedProviderId);
    if (found) {
      setSelectedId(found.id);
      setNewlyCreatedProviderId("");
    }
  }, [interests, newlyCreatedProviderId]);

  function addSite() {
    if (!draft) return;
    const host = normalizeLeagueWebsite(newWebsite);
    if (!host) {
      setProblem("Enter an HTTPS domain or site path, for example nba.com or espn.com/nba.");
      return;
    }
    if (draft.websites.some((item) => item.host === host)) {
      setProblem("This website is already in the list.");
      return;
    }
    if (draft.websites.length >= 10) {
      setProblem("Use no more than 10 websites per interest.");
      return;
    }
    setProblem("");
    update("websites", [...draft.websites, { host, mode: newSiteMode }]);
    setNewWebsite("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft || busy) return;
    if (!name.trim()) { setProblem("Enter an interest name."); return; }
    if (draft.timeRange === "custom" && (
      !draft.dateFrom || !draft.dateTo || draft.dateFrom > draft.dateTo
    )) { setProblem("Choose a valid custom date range."); return; }
    setBusy(true);
    setProblem("");
    try {
      await saveFollowedInterest({
        kind: selected.kind, provider: selected.provider,
        providerId: selected.providerId, title: name.trim(),
        parentId: selected.parentId, preferences: draft as unknown as Record<string, unknown>,
      });
      setNotice("Category search settings saved. Gallery will use these preferences.");
      onChanged();
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setProblem("");
    try {
      await removeFollowedInterest(deleting.id);
      setDeleting(null);
      setSelectedId("");
      setNotice("Interest removed. Saved Library wallpapers were kept.");
      onChanged();
    } catch (reason) {
      setProblem(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  const inherited = selected ? linkedWebsites(selected, interests).filter((site) =>
    !draft?.websites.some((direct) => direct.host === site.host)
  ) : [];
  return (
    <section className="hwi-wrapper" aria-label="Category search configurations">
      <div className="hwi-intro">
        <h2>Categories & Saved Interests</h2>
        <p>Define what to search for, where to search, and how recent images should be.
          Gallery uses these saved settings. Collections organize already-saved images.</p>
      </div>
      {error && <p className="hwi-error" role="alert">{error}</p>}
      {loading && <p className="hwi-muted" role="status">Loading saved interests…</p>}
      <div className="hwi-layout">
        <aside className="hwi-tree">
          <button type="button" className="hwi-primary" onClick={() => {
            setCreating(true); setProblem(""); setNotice("");
            setProviderMatches([]); setProviderChoice(null);
          }}>+ Add interest / category</button>
          {(["Sports", "TV & Movies", "Places & More"] as const).map((family) => {
            const matches = interests.filter((item) => familyForKind(item.kind) === family);
            return (
              <section key={family} className="hwi-tree-family">
                <h3>{family} <span>{matches.length}</span></h3>
                {matches.map((item) => (
                  <button key={item.id} type="button" onClick={() => setSelectedId(item.id)}
                    className={"hwi-tree-node" + (item.id === selected?.id ? " selected" : "")}>
                    <span>{item.title}</span><small>{kindLabel(item.kind)}</small>
                  </button>
                ))}
                {matches.length === 0 && <small className="hwi-muted">No interests yet.</small>}
              </section>
            );
          })}
        </aside>
        <div className="hwi-details">
          {!selected || !draft ? (
            <div className="hwi-empty">
              <strong>No category configured yet</strong>
              <p>Create your first interest, such as NBA, Golden State Warriors,
                Landman, or Swiss Alps.</p>
            </div>
          ) : (
            <>
              <div className="hwi-editor-heading">
                <div>
                  <small>{familyForKind(selected.kind)} / {kindLabel(selected.kind)}</small>
                  <h3>{selected.title}</h3>
                  {selected.parentId && <p>Inherits websites from
                    {" "}{interests.find((p) => p.id === selected.parentId)?.title ?? "another interest"},
                    unless inheritance is disabled.</p>}
                </div>
                <button type="button" className="hwi-danger" onClick={() => setDeleting(selected)}>
                  Remove interest
                </button>
              </div>
              <form id="hwi-preferences-form" onSubmit={(event) => void save(event)}>
                <div className="hwi-fields">
                  <label>Display name
                    <input value={name} maxLength={60} disabled={busy}
                      onChange={(event) => setName(event.target.value)}/>
                  </label>
                  <label>Search keyword
                    <input value={draft.keyword} maxLength={160} disabled={busy}
                      onChange={(event) => update("keyword", event.target.value)}/>
                  </label>
                  <label>Google Images time filter
                    <select value={draft.timeRange} disabled={busy}
                      onChange={(event) => update("timeRange", event.target.value as InterestPreferences["timeRange"])}>
                      {WINDOW_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>Excluded keywords (comma-separated)
                    <input value={draft.exclusions} maxLength={240} disabled={busy}
                      onChange={(event) => update("exclusions", event.target.value)}/>
                  </label>
                </div>
                {draft.timeRange === "custom" && (
                  <div className="hwi-fields">
                    <label>From <input type="date" value={draft.dateFrom}
                      onChange={(event) => update("dateFrom", event.target.value)}/></label>
                    <label>To <input type="date" value={draft.dateTo}
                      onChange={(event) => update("dateTo", event.target.value)}/></label>
                  </div>
                )}
                <div className="hwi-checks">
                  <label><input type="checkbox" checked={draft.googleEnabled}
                    onChange={(event) => update("googleEnabled", event.target.checked)}/>
                    Include general Google Images results</label>
                  <label><input type="checkbox" checked={draft.providerEnabled}
                    onChange={(event) => update("providerEnabled", event.target.checked)}/>
                    Use available {selected.kind === "tv" || selected.kind === "movie" ? "TMDB" : "sports provider"} artwork</label>
                  {selected.parentId && <label><input type="checkbox"
                    checked={draft.inheritWebsites}
                    onChange={(event) => update("inheritWebsites", event.target.checked)}/>
                    Inherit parent websites</label>}
                </div>
                <h4>Preferred image websites</h4>
                <p className="hwi-muted">Use Google Images site search for the keyword, or open a website
                  in Browser and click Find Images on that page.</p>
                <div className="hwi-sites">
                  {draft.websites.map((site) => <div key={site.host} className="hwi-site">
                    <span>{site.host}</span>
                    <select value={site.mode} aria-label={"Search method for " + site.host}
                      onChange={(event) => update("websites", draft.websites.map((item) =>
                        item.host === site.host ? { ...item, mode: event.target.value as WebsiteMode } : item
                      ))}>
                      <option value="google">Google site: search</option>
                      <option value="browser">Browser Find Images</option>
                    </select>
                    <button type="button" aria-label={"Remove " + site.host}
                      onClick={() => update("websites", draft.websites.filter((item) => item.host !== site.host))}>×</button>
                  </div>)}
                  {inherited.map((site) => (
                    <div key={site.host} className="hwi-site inherited">
                      <span>{site.host}</span><small>Inherited · {site.mode === "google" ? "Google site search" : "Browser"}</small>
                    </div>
                  ))}
                </div>
                <div className="hwi-add-site">
                  <input placeholder="e.g. nba.com or espn.com/nba"
                    aria-label="New website" value={newWebsite}
                    onChange={(event) => setNewWebsite(event.target.value)}/>
                  <select form="hwi-website-form" aria-label="New website search method"
                    value={newSiteMode}
                    onChange={(event) => setNewSiteMode(event.target.value as WebsiteMode)}>
                    <option value="google">Google site: search</option>
                    <option value="browser">Browser Find Images</option>
                  </select>
                  <button type="button" onClick={addSite}>
                    + Add website
                  </button>
                </div>
                <h4>Preferred artwork</h4>
                <div className="hwi-artwork">
                  {ARTWORK.filter((type) =>
                    (selected.kind === "league" || selected.kind === "team" || selected.kind === "player")
                      ? ["Teams", "Players", "Game action", "Logos", "Other"].includes(type)
                      : ["tv", "movie"].includes(selected.kind)
                        ? ["Backdrops", "Posters", "Episode stills", "Other"].includes(type)
                        : ["Landscapes", "Other"].includes(type)
                  ).map((type) => <label key={type}>
                    <input type="checkbox" checked={draft.artwork.includes(type)}
                      onChange={(event) => update("artwork", event.target.checked
                        ? [...draft.artwork, type] : draft.artwork.filter((item) => item !== type))}/>
                    {type}</label>)}
                </div>
                <p className="hwi-muted">Search recency is not the automatic discovery schedule.
                  Unattended downloads remain limited to approved sources.</p>
                {notice && <p className="hwi-success" role="status">{notice}</p>}
                {problem && <p className="hwi-error" role="alert">{problem}</p>}
                <div className="hwi-actions">
                  <button type="submit" className="hwi-primary" disabled={busy}>
                    {busy ? "Saving…" : "Save category settings"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => onPreview(selected)}>
                    Find wallpapers in Gallery →
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
      {creating && (
        <div className="hwi-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setCreating(false);
        }}>
          <form className="hwi-modal" onSubmit={(event) => void create(event)}
            role="dialog" aria-modal="true" aria-label="Create saved interest">
            <h3>Add interest / category</h3>
            <p>Create a reusable search profile. It appears in Gallery automatically.</p>
            <label>Interest type
              <select value={newType} onChange={(event) => {
                setNewType(event.target.value as InterestKind); setNewParent("");
                setProviderMatches([]); setProviderChoice(null);
              }}>
                {INTEREST_TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>Name
              <input autoFocus required value={newName} maxLength={60}
                placeholder="e.g. Golden State Warriors" onChange={(event) => {
                  setNewName(event.target.value);
                  setProviderMatches([]); setProviderChoice(null);
                }}/>
            </label>
            {(newType === "team" || newType === "tv") && (
              <div className="hwi-lookup">
                <button type="button" disabled={!newName.trim() || lookupBusy}
                  onClick={() => void lookUpProvider()}>
                  {lookupBusy ? "Finding matches…" :
                    "Find exact " + (newType === "tv" ? "TMDB show" : "TheSportsDB team")}
                </button>
                {providerChoice && <small>Selected: {providerChoice.title} · {providerChoice.id}</small>}
                {providerMatches.length > 0 && (
                  <div className="hwi-lookup-results">
                    {providerMatches.map((item) => (
                      <button type="button" key={item.id}
                        className={providerChoice?.id === item.id ? "selected" : ""}
                        onClick={() => setProviderChoice(item)}>
                        <img src={item.previewUrl} alt="" loading="lazy"/>
                        <span><strong>{item.title}</strong>
                          <small>{item.credit}</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {allowedParents(newType).length > 0 && <label>Parent (optional)
              <select value={newParent} onChange={(event) => setNewParent(event.target.value)}>
                <option value="">Independent interest</option>
                {allowedParents(newType).map((item) => (
                  <option key={item.id} value={item.id}>{item.title}</option>
                ))}
              </select>
            </label>}
            <p className="hwi-muted">Matching a team or TV show saves its provider ID.
              Otherwise, keyword-only interests still work with Google and saved websites.
              Exact movie matching and player lookup will follow in a later integration.</p>
            {problem && <p className="hwi-error" role="alert">{problem}</p>}
            <div className="hwi-actions">
              <button type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" disabled={busy || !newName.trim()}>Create interest</button>
            </div>
          </form>
        </div>
      )}
      {deleting && (
        <ConfirmDialog title={"Remove " + deleting.title + "?"}
          description="The saved search settings will be removed from Gallery. Your saved wallpapers and collections will remain."
          confirmLabel="Remove interest" tone="danger" busy={busy}
          onConfirm={() => void remove()} onCancel={() => setDeleting(null)}/>
      )}
    </section>
  );
}
