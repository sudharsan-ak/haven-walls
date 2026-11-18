import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  browseGoogleImages, browseTMDBBackdrops, browseWallpaperSource,
  type CatalogImage, type CatalogSourceId,
} from "../lib/native";
import {
  loadPersonalizationWithMigration, linkedWebsites, preferencesFor,
  familyForKind, kindLabel, type InterestPreferences, type SearchWindow,
} from "../lib/interestProfiles";
import type { FollowedInterest } from "../lib/personalization";
import FullResolutionPreview from "./FullResolutionPreview";
import ConfirmDialog from "./ConfirmDialog";
import "./SavedInterestGallery.css";

interface Props {
  source: CatalogSourceId;
  interestSeedId: string | null;
  onSaveToLibrary: (images: CatalogImage[]) => void;
  onManageCategories: () => void;
  onOpenBrowserWebsite: (url: string) => void;
}
interface Result {
  image: CatalogImage;
  foundAt: string;
}
interface Job {
  label: string;
  interest: FollowedInterest;
  query: string;
  website?: string;
  provider?: "sports" | "tmdb";
}
function urlIdentity(image: CatalogImage): string {
  const url = image.originalUrl || image.previewUrl;
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    } catch { /* Keep source ID. */ }
  }
  return image.source + ":" + image.id;
}
function searchSuffix(interest: FollowedInterest): string {
  return interest.kind === "movie" ? "movie wallpaper" :
    interest.kind === "tv" ? "TV show wallpaper" :
      interest.kind === "place" ? "landscape wallpaper" : "4K desktop wallpaper";
}
function windowText(value: SearchWindow): string {
  return ({ day: "Past 24 hours", week: "Past week", month: "Past month",
    year: "Past year", any: "Any time", custom: "Custom date range" })[value];
}
function browserLink(host: string) {
  return "https://" + host;
}
function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SavedInterestGallery({
  source, interestSeedId, onSaveToLibrary, onManageCategories, onOpenBrowserWebsite,
}: Props) {
  const [interests, setInterests] = useState<FollowedInterest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState("__all__");
  const [keyword, setKeyword] = useState("");
  const [range, setRange] = useState<SearchWindow>("day");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [sourceFilter, setSourceFilter] = useState("All sources");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [searched, setSearched] = useState(false);
  const [inspect, setInspect] = useState<CatalogImage | null>(null);
  const [review, setReview] = useState<CatalogImage[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [pendingSearch, setPendingSearch] = useState<Job[] | null>(null);
  const requestId = useRef(0);
  const scope = useMemo(() => interests.filter((item) =>
    source === "sports" ? familyForKind(item.kind) === "Sports" :
      source === "tmdb" ? familyForKind(item.kind) === "TV & Movies" : true
  ), [interests, source]);
  const selected = scope.find((item) => item.id === selectedId) ?? null;
  const all = source === "discover" && selectedId === "__all__";

  useEffect(() => {
    let active = true;
    setLoaded(false);
    void loadPersonalizationWithMigration().then((snapshot) => {
      if (!active) return;
      setInterests(snapshot.followedInterests);
      setLoadError("");
    }).catch((cause: unknown) => {
      if (active) setLoadError(displayError(cause));
    }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const permitted = scope.some((item) => item.id === selectedId);
    const target = interestSeedId && scope.some((item) => item.id === interestSeedId)
      ? interestSeedId
      : source === "discover"
        ? (selectedId === "__all__" || permitted ? selectedId : "__all__")
        : permitted ? selectedId : scope[0]?.id ?? "";
    setSelectedId(target);
  }, [source, interests, interestSeedId, scope]);

  useEffect(() => {
    if (!selected) {
      setKeyword("");
      return;
    }
    const prefs = preferencesFor(selected);
    setKeyword(prefs.keyword);
    setRange(prefs.timeRange);
    setFrom(prefs.dateFrom);
    setTo(prefs.dateTo);
  }, [selected?.id, selected?.preferences]);

  // Switching tabs or changing interest selection must never show stale results.
  useEffect(() => {
    requestId.current++;
    setBusy(false);
    setResults([]);
    setErrors([]);
    setSearched(false);
    setSourceFilter("All sources");
    setProgress("");
  }, [source, selectedId]);

  function jobs(): Job[] {
    const targets = all ? scope : selected ? [selected] : [];
    const tasks: Job[] = [];
    for (const interest of targets) {
      const prefs = preferencesFor(interest);
      const term = all ? prefs.keyword : keyword.trim();
      if (!term) continue;
      const query = term + " " + searchSuffix(interest);
      if (prefs.googleEnabled) tasks.push({ label: "Google Images", interest, query });
      for (const site of linkedWebsites(interest, interests)) {
        if (site.mode !== "google") continue;
        tasks.push({
          label: site.host, interest,
          website: site.host, query: query + " site:" + site.host,
        });
      }
      if (prefs.providerEnabled) {
        if (interest.kind === "team") {
          tasks.push({ label: "TheSportsDB", interest, query: term, provider: "sports" });
        }
        if (interest.kind === "tv" && interest.provider === "tmdb" &&
          /^\d+$/.test(interest.providerId)) {
          tasks.push({ label: "TMDB", interest,
            query: interest.providerId, provider: "tmdb" });
        }
      }
    }
    return tasks;
  }

  function beginSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy) return;
    if (!all && !selected) { setErrors(["Choose a saved interest first."]); return; }
    if (!all && range === "custom" && (!from || !to || from > to)) {
      setErrors(["Select valid start and end dates."]); return;
    }
    const tasks = jobs();
    if (tasks.length === 0) {
      setErrors(["Enable Google Images or website searches in Library → Categories."]); return;
    }
    if (tasks.length > 60) {
      setErrors(["This selection would run over 60 searches. Choose a specific interest to reduce API usage."]);
      return;
    }
    if (tasks.length > 5) { setPendingSearch(tasks); return; }
    void runSearch(tasks);
  }

  async function runSearch(tasks: Job[]) {
    setPendingSearch(null);
    const run = ++requestId.current;
    setBusy(true);
    setSearched(false);
    setResults([]);
    setErrors([]);
    setSourceFilter("All sources");
    const found: Result[] = [];
    const seen = new Set<string>();
    const problems: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      if (requestId.current !== run) return;
      const task = tasks[i];
      setProgress("Searching " + task.label + " · " + (i + 1) + " of " + tasks.length);
      try {
        let images: CatalogImage[];
        if (task.provider === "sports") {
          const response = await browseWallpaperSource("sports", task.query);
          images = response.items.filter((item) => item.kind === "image");
        } else if (task.provider === "tmdb") {
          const response = await browseTMDBBackdrops(Number(task.query));
          images = response.items.filter((item) => item.kind === "image");
        } else {
          const pref = preferencesFor(task.interest);
          const timeFilter = all ? pref : { ...pref,
            timeRange: range, dateFrom: from, dateTo: to,
          };
          const response = await browseGoogleImages(
            task.query, 1920, 1080, 1, {
              timeRange: timeFilter.timeRange,
              dateFrom: timeFilter.dateFrom, dateTo: timeFilter.dateTo,
            }
          );
          images = response.items;
        }
        for (const image of images) {
          const key = urlIdentity(image);
          if (seen.has(key)) continue;
          seen.add(key);
          // Google returns position-based IDs (google-1, google-2) for each
          // search. Namespace them so Review/import never collides across sites.
          found.push({ image: { ...image, id: "interest-" + i + "-" + image.id },
            foundAt: task.label });
        }
        // Show partial results while other sources run.
        if (requestId.current === run) setResults([...found]);
      } catch (cause) {
        problems.push(task.label + ": " + displayError(cause));
      }
    }
    if (requestId.current !== run) return;
    setErrors(problems);
    setProgress("");
    setBusy(false);
    setSearched(true);
  }

  const shown = sourceFilter === "All sources" ? results :
    results.filter((item) => item.foundAt === sourceFilter);
  const sourceLabels = [...new Set(results.map((item) => item.foundAt))];
  const activeSites = selected ? linkedWebsites(selected, interests) : [];
  const profilePrefs: InterestPreferences | null = selected ? preferencesFor(selected) : null;
  const heading = source === "sports" ? "Sports Interests" :
    source === "tmdb" ? "TV & Movies" : "Discover";

  function queueImage(image: CatalogImage) {
    setReview((current) => current.some((item) => urlIdentity(item) === urlIdentity(image))
      ? current : [...current, image].slice(0, 30));
  }

  return (
    <section className="hwsi" aria-label="Search saved interests">
      <div className="hwsi-message">
        <span><strong>Synced with Library → Categories.</strong> {scope.length}
          {" "}saved {heading.toLowerCase()} {scope.length === 1 ? "interest" : "interests"} available.</span>
        <button type="button" onClick={onManageCategories}>Manage saved interests</button>
      </div>
      <form className="hwsi-search" onSubmit={beginSearch}>
        <div className="hwsi-search-main">
          <h2>{heading === "Discover" ? "Discover from your interests" : heading}</h2>
          <p>Search using category keywords, time windows, and preferred image websites.</p>
          <label className="hwsi-field">Saved interests
            <select aria-label="Select a saved interest" value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)} disabled={!loaded}>
              {source === "discover" && <option value="__all__">
                All saved interests ({scope.length})
              </option>}
              {scope.length === 0 && source !== "discover" &&
                <option value="">No saved interests</option>}
              {(source === "sports" ? ["league", "team", "player"] :
                source === "tmdb" ? ["tv", "movie"] :
                  ["league", "team", "player", "tv", "movie", "place"]).map((kind) => {
                const group = scope.filter((item) => item.kind === kind);
                return group.length > 0 ? <optgroup key={kind} label={kindLabel(kind) + "s"}>
                  {group.map((item) => <option key={item.id} value={item.id}>
                    {item.title}
                  </option>)}
                </optgroup> : null;
              })}
            </select>
          </label>
          <label className="hwsi-field">Search keyword
            <input type="search" value={all ? "Each interest uses its saved keyword" : keyword}
              disabled={all || busy} maxLength={160}
              placeholder="Choose a saved interest" onChange={(event) => setKeyword(event.target.value)}/>
          </label>
          <div className="hwsi-source-list">
            <strong>Search sources</strong>
            {all ? <span>Uses each interest's saved sources</span> : (
              <>
                {profilePrefs?.googleEnabled && <span>Google Images</span>}
                {profilePrefs?.providerEnabled && <span>
                  {selected?.kind === "tv" || selected?.kind === "movie" ? "TMDB (linked IDs)" : "Sports provider"}
                </span>}
                {activeSites.filter((site) => site.mode === "google").map((site) =>
                  <span key={site.host}>site:{site.host}</span>)}
              </>
            )}
          </div>
          {activeSites.some((site) => site.mode === "browser") && (
            <div className="hwsi-browser-sources">
              <strong>Websites for Browser Find Images</strong>
              {activeSites.filter((site) => site.mode === "browser").map((site) => (
                <button key={site.host} type="button"
                  onClick={() => onOpenBrowserWebsite(browserLink(site.host))}>
                  Open {site.host} in Browser
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="hwsi-search-side">
          <label className="hwsi-field">Google Images time filter
            <select value={range} disabled={all || busy}
              onChange={(event) => setRange(event.target.value as SearchWindow)}>
              {(["day", "week", "month", "year", "any", "custom"] as const).map((value) =>
                <option key={value} value={value}>{windowText(value)}</option>)}
            </select>
          </label>
          {range === "custom" && !all && <div className="hwsi-date-grid">
            <label>From<input type="date" value={from} disabled={busy}
              onChange={(event) => setFrom(event.target.value)}/></label>
            <label>To<input type="date" value={to} disabled={busy}
              onChange={(event) => setTo(event.target.value)}/></label>
          </div>}
          <p>Google's date filter applies to indexed content, not necessarily when a photo was taken.</p>
          <button type="submit" disabled={busy || !loaded || scope.length === 0}>
            {busy ? "Searching…" : "Find wallpapers"}
          </button>
        </aside>
      </form>

      {loadError && <p className="hwsi-error" role="alert">{loadError}</p>}
      {busy && <p className="hwsi-status" role="status">{progress}</p>}
      {errors.map((problem, index) => <p className="hwsi-error" key={index} role="alert">{problem}</p>)}

      <div className="hwsi-results-heading">
        <div>
          <h2>Discoveries <small>{results.length} images</small></h2>
          <p>One grid for Google, provider, and website results. Duplicates are removed by image URL.</p>
        </div>
        <button type="button" disabled={review.length === 0}
          onClick={() => setShowReview(true)}>Review selection · {review.length}</button>
      </div>
      {sourceLabels.length > 0 && <div className="hwsi-filters" role="group" aria-label="Filter results by source">
        {["All sources", ...sourceLabels].map((label) =>
          <button key={label} type="button" aria-pressed={sourceFilter === label}
            className={sourceFilter === label ? "active" : ""}
            onClick={() => setSourceFilter(label)}>{label}</button>)}
      </div>}
      {shown.length > 0 ? (
        <div className="hwsi-grid">
          {shown.map(({ image, foundAt }) => <article key={urlIdentity(image)} className="hwsi-tile">
            <button type="button" onClick={() => setInspect(image)}
              aria-label={"Inspect " + image.title}>
              <img src={image.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>
              <span>{image.width > 0 ? image.width + " × " + image.height : "Artwork"}</span>
            </button>
            <div><strong title={image.title}>{image.title}</strong><small>{foundAt} · {image.source}</small>
              <button type="button" onClick={() => setInspect(image)}>Inspect image</button></div>
          </article>)}
        </div>
      ) : (
        <div className="hwsi-empty">
          <strong>{busy ? "Collecting image results…" :
            searched ? "No suitable images found" : "Ready to discover"}</strong>
          <p>{searched ? "Try a wider time range, a different keyword, or another saved source." :
            "Choose an interest and click Find wallpapers to search its configured websites."}</p>
        </div>
      )}
      <p className="hwsi-disclaimer">Search results are previews, not permission to reuse an image.
        Browser Find Images operates on explicitly opened pages, not an unattended whole-site crawl.
        Import checks still apply.</p>

      {inspect && <FullResolutionPreview image={inspect}
        onClose={() => setInspect(null)}
        onAddToLibrary={(image) => { queueImage(image); setInspect(null); }}/>}
      {showReview && (
        <div className="hwsi-review-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowReview(false);
        }}>
          <section role="dialog" aria-modal="true" aria-label="Review selected images"
            className="hwsi-review">
            <h3>Review selection</h3>
            <p>Review up to 30 previews before opening the existing Library import checks.</p>
            {review.map((image) => <div key={urlIdentity(image)} className="hwsi-review-row">
              <span>{image.title}</span>
              <button type="button" onClick={() => setReview((before) =>
                before.filter((item) => urlIdentity(item) !== urlIdentity(image)))}>Remove</button>
            </div>)}
            <div className="hwsi-review-actions">
              <button type="button" onClick={() => setShowReview(false)}>Close</button>
              <button type="button" disabled={review.length === 0} onClick={() => {
                onSaveToLibrary(review);
                setReview([]);
                setShowReview(false);
              }}>Continue to Library review</button>
            </div>
          </section>
        </div>
      )}
      {pendingSearch && <ConfirmDialog
        title={"Run " + pendingSearch.length + " image searches?"}
        description="Each Google Images request can use a SerpApi credit. Searches run only after you confirm."
        confirmLabel="Run searches" tone="standard"
        onConfirm={() => { void runSearch(pendingSearch); }}
        onCancel={() => setPendingSearch(null)} />}
    </section>
  );
}
