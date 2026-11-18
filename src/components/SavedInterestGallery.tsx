import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  browseGoogleImages, browseTMDBBackdrops, browseWallpaperSource,
  type CatalogImage, type CatalogSourceId,
} from "../lib/native";
import {
  loadPersonalizationWithMigration, linkedWebsites, preferencesFor,
  familyForKind, kindLabel, type InterestPreferences, type SearchWindow,
} from "../lib/interestProfiles";
import type { FollowedInterest, InterestKind } from "../lib/personalization";
import FullResolutionPreview from "./FullResolutionPreview";
import ConfirmDialog from "./ConfirmDialog";
import type { BrowserScanResponse } from "../lib/browserNative";
import {
  googleImageSearchUrl, readInterestSearchMode, saveInterestSearchMode,
  scanInterestSearchPage, type InterestSearchMode,
} from "../lib/interestWebScan";
import type { WebsiteMode } from "../lib/interestProfiles";
import "./SavedInterestGallery.css";

interface Props {
  source: CatalogSourceId;
  interestSeedId: string | null;
  onSaveToLibrary: (images: CatalogImage[]) => void;
  onManageCategories: () => void;
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
  method?: "browser" | "serpapi";
  siteMode?: WebsiteMode;
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
function scannedImages(
  response: BrowserScanResponse,
  label: string,
  keyword: string,
  onlyRelevant: boolean,
): CatalogImage[] {
  const tokens = keyword.toLowerCase().split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 4);
  return response.images.filter((candidate) => {
    // Google often renders small thumbnails for full-resolution photos.
    // Don't reject a candidate just because its preview dimensions are small.
    if (candidate.width >= 600 && candidate.height >= 600 &&
        candidate.width < candidate.height) return false;
    // Direct webpage scans are not inherently searches. Keep only images
    // whose text or URL indicates a relationship to the chosen category.
    if (onlyRelevant && tokens.length) {
      const metadata = (candidate.title + " " + candidate.url).toLowerCase();
      return tokens.some((token) => metadata.includes(token));
    }
    return true;
  }).map((candidate, index) => ({
    id: "interest-browser-" + index,
    source: label + " · Find Images",
    title: candidate.title || "Website image",
    previewUrl: candidate.url,
    originalUrl: candidate.originalUrl,
    candidateUrls: candidate.candidateUrls,
    pageUrl: candidate.sourcePageUrl || response.pageUrl,
    credit: response.pageUrl,
    rights: "Image rights are not verified. Inspect the original publisher and permissions before saving.",
    width: candidate.width,
    height: candidate.height,
    kind: "image" as const,
  }));
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
  source, interestSeedId, onSaveToLibrary, onManageCategories,
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
  const [searchMode, setSearchMode] = useState<InterestSearchMode>(readInterestSearchMode);
  const requestId = useRef(0);
  const scanController = useRef<AbortController | null>(null);
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
    scanController.current?.abort();
    requestId.current++;
    setPendingSearch(null);
    setBusy(false);
    setResults([]);
    setErrors([]);
    setSearched(false);
    setSourceFilter("All sources");
    setProgress("");
  }, [source, selectedId]);

  // Search per category keyword. A "website" can use a direct page scan
  // or Google Images site: search, but neither needs SerpApi by default.
  useEffect(() => () => scanController.current?.abort(), []);

  function jobs(): Job[] {
    const targets = all ? scope : selected ? [selected] : [];
    const tasks: Job[] = [];
    const methods: ("browser" | "serpapi")[] =
      searchMode === "both" ? ["browser", "serpapi"] : [searchMode];
    for (const interest of targets) {
      const prefs = preferencesFor(interest);
      const term = (all ? prefs.keyword : keyword).trim();
      if (!term) continue;
      if (prefs.googleEnabled) {
        for (const method of methods) {
          tasks.push({
            label: method === "browser" ? "Google Images" : "Google Images (SerpApi)",
            interest, query: term, method,
          });
        }
      }
      for (const site of linkedWebsites(interest, interests)) {
        for (const method of methods) {
          tasks.push({
            label: site.host + (method === "serpapi" ? " (SerpApi)" : ""),
            interest, website: site.host,
            siteMode: site.mode, method,
            query: term + " site:" + site.host,
          });
        }
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
    if (tasks.length > 24) {
      setErrors(["This selection contains over 24 searches. Choose a specific interest first."]);
      return;
    }
    const paidRequests = tasks.filter((task) => task.method === "serpapi").length;
    if (paidRequests > 5 || tasks.length > 10) {
      setPendingSearch(tasks); return;
    }
    void runSearch(tasks);
  }

  async function runSearch(tasks: Job[]) {
    setPendingSearch(null);
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
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
      if (requestId.current !== run || controller.signal.aborted) return;
      const task = tasks[i];
      setProgress("Finding images from " + task.label + " · " + (i + 1) +
        " of " + tasks.length);
      try {
        let images: CatalogImage[];
        if (task.provider === "sports") {
          const response = await browseWallpaperSource("sports", task.query);
          images = response.items.filter((item) => item.kind === "image");
        } else if (task.provider === "tmdb") {
          const response = await browseTMDBBackdrops(Number(task.query));
          images = response.items.filter((item) => item.kind === "image");
        } else if (task.method === "serpapi") {
          const pref = preferencesFor(task.interest);
          const timeFilter = all ? pref : {
            ...pref, timeRange: range, dateFrom: from, dateTo: to,
          };
          const response = await browseGoogleImages(task.query, 1920, 1080, 1, {
            timeRange: timeFilter.timeRange,
            dateFrom: timeFilter.dateFrom, dateTo: timeFilter.dateTo,
          });
          images = response.items;
        } else {
          const pref = preferencesFor(task.interest);
          const window = all ? pref.timeRange : range;
          const start = all ? pref.dateFrom : from;
          const end = all ? pref.dateTo : to;
          const searchId = "g" + run + "-" + i + "-" + Date.now().toString(36);
          // Some website profiles deliberately scan a direct page first.
          // They fall back to the category-specific Google site: query if the
          // site exposes no matching images or refuses the page scan.
          if (task.website && task.siteMode === "browser") {
            let direct: CatalogImage[] = [];
            try {
              const page = await scanInterestSearchPage(
                browserLink(task.website), searchId + "-s", controller.signal,
              );
              direct = scannedImages(page, task.label, preferencesFor(task.interest).keyword, true);
            } catch {
              if (controller.signal.aborted) return;
              // A site may block scanning. The Google site: fallback below
              // is expected behavior and should not show a recovered error.
            }
            if (direct.length > 0) {
              images = direct;
            } else {
              const page = await scanInterestSearchPage(
                googleImageSearchUrl(task.query, window, start, end),
                searchId + "-g", controller.signal,
              );
              images = scannedImages(page, task.label, task.query, false);
            }
          } else {
            const page = await scanInterestSearchPage(
              googleImageSearchUrl(task.query, window, start, end),
              searchId, controller.signal,
            );
            images = scannedImages(page, task.label, task.query, false);
          }
        }
        if (controller.signal.aborted || requestId.current !== run) return;
        for (const image of images) {
          const key = urlIdentity(image);
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({
            image: { ...image, id: "interest-" + run + "-" + i + "-" + image.id },
            foundAt: task.label,
          });
        }
        setResults([...found]);
      } catch (cause) {
        if (controller.signal.aborted || requestId.current !== run) return;
        problems.push(task.label + ": " + displayError(cause));
      }
    }
    if (requestId.current !== run || controller.signal.aborted) return;
    scanController.current = null;
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
  const visibleKinds: InterestKind[] = source === "sports"
    ? ["league", "team", "player"]
    : source === "tmdb"
      ? ["tv", "movie"]
      : ["league", "team", "player", "tv", "movie", "place"];
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
              {visibleKinds.map((kind) => {
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
                {activeSites.map((site) =>
                  <span key={site.host}>site:{site.host}</span>)}
              </>
            )}
          </div>
          {activeSites.some((site) => site.mode === "browser") && (
            <div className="hwsi-browser-sources">
              <strong>Direct page scanning (inside Gallery)</strong>
              {activeSites.filter((site) => site.mode === "browser").map((site) =>
                <span key={site.host}>{site.host} · Find Images, then site: fallback</span>
              )}
            </div>
          )}
        </div>
        <aside className="hwsi-search-side">
          <label className="hwsi-field">Search method
            <select value={searchMode} disabled={busy}
              onChange={(event) => {
                const value = event.target.value as InterestSearchMode;
                setSearchMode(value);
                saveInterestSearchMode(value);
              }}>
              <option value="browser">Built-in Browser · No API key</option>
              <option value="serpapi">SerpApi · Optional API key</option>
              <option value="both">Both methods</option>
            </select>
          </label>
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
          <p>The built-in WebView2 scanner works inside Gallery. It reads image
            candidates from loaded search pages, not entire websites. Some sites
            limit access. SerpApi is only used when selected.</p>
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
        Built-in Find Images scans loaded pages in an isolated view without leaving Gallery, not an unattended whole-site crawl.
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
        description={"This runs " + pendingSearch.filter((task) =>
          task.method === "serpapi").length + " optional SerpApi requests and " +
          pendingSearch.filter((task) => task.method === "browser").length +
          " built-in page scans. Continue?"}
        confirmLabel="Run searches" tone="standard"
        onConfirm={() => { void runSearch(pendingSearch); }}
        onCancel={() => setPendingSearch(null)} />}
    </section>
  );
}
