import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  browseCategoryImages, browseGoogleImages, type CatalogImage, type CatalogResponse,
  type CatalogSourceId, type CategoryProvider,
} from "../lib/native";
import FullResolutionPreview from "./FullResolutionPreview";
import "./CategoryDiscovery.css";

type Category = {
  id: string; name: string; icon: string; description: string; prompt: string;
  topics: string[]; custom?: boolean;
};
type SourceChoice = "all" | CategoryProvider | "google";
type Quality = "all" | "1080p" | "4k";
type Result = { photo: CatalogImage; key: string };

const CUSTOM_KEY = "haven-walls.discover.categories.v1";
const PRIMARY: Category[] = [
  { id: "nature", name: "Nature", icon: "⛰", description: "Mountains, forests & lakes",
    prompt: "landscape nature photography", topics: ["All", "Mountains", "Forests", "Lakes", "Beaches", "Sunsets"] },
  { id: "earth", name: "Earth & Aerial", icon: "🌎", description: "Our planet from above",
    prompt: "earth aerial landscape", topics: ["All", "Oceans", "Islands", "Coastlines", "Deserts"] },
  { id: "space", name: "Space", icon: "✦", description: "Planets, stars & galaxies",
    prompt: "space nebula galaxy", topics: ["All", "Nebulae", "Galaxies", "Planets", "Moon", "Stars"] },
  { id: "animals", name: "Animals", icon: "🐅", description: "Wildlife & nature",
    prompt: "wildlife animal photography", topics: ["All", "Wildlife", "Big cats", "Birds", "Ocean life"] },
  { id: "places", name: "Places & Cities", icon: "▤", description: "Landmarks & cityscapes",
    prompt: "city skyline landmark photography", topics: ["All", "Cities", "Landmarks", "Architecture", "Night"] },
  { id: "sports", name: "Sports", icon: "🏀", description: "NBA, teams & action",
    prompt: "sports action photography", topics: ["All", "NBA", "Warriors", "Basketball", "Football"] },
];
const SOURCE_OPTIONS: { id: SourceChoice; label: string }[] = [
  { id: "all", label: "All enabled sources" }, { id: "commons", label: "Wikimedia Commons" },
  { id: "nasa", label: "NASA" }, { id: "unsplash", label: "Unsplash" },
  { id: "google", label: "Google via SerpApi" },
];
function loadCustom(): Category[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 12).filter((v): v is Category =>
      v !== null && typeof v === "object" &&
      typeof v.id === "string" && v.id.startsWith("custom-") &&
      typeof v.name === "string" && typeof v.prompt === "string" &&
      v.name.length <= 36 && v.prompt.length <= 100 && v.prompt.length >= 2 &&
      Array.isArray(v.topics) && v.topics.every((t: unknown) => typeof t === "string")
    ).map((v) => ({ ...v, icon: "✧", custom: true, topics: v.topics.slice(0, 8) }));
  } catch { return []; }
}
function displayQuality(image: CatalogImage): string {
  if (image.width <= 0 || image.height <= 0) return "Size unknown";
  if (image.width >= 3840 && image.height >= 2160) return "4K+ reported";
  if (image.width >= 1920 && image.height >= 1080) return "1080p+ reported";
  return image.width + " × " + image.height;
}
function passesQuality(photo: CatalogImage, quality: Quality) {
  if (quality === "all") return true;
  if (quality === "4k") return photo.width >= 3840 && photo.height >= 2160;
  return photo.width >= 1920 && photo.height >= 1080;
}
function imageKey(photo: CatalogImage): string {
  return photo.originalUrl || photo.previewUrl || photo.id;
}
interface Props {
  onSourceChange: (source: CatalogSourceId) => void;
  onSaveToLibrary: (images: CatalogImage[]) => void;
  serpapiKey: string;
  onSerpapiKeyChange: (value: string) => void;
  unsplashKey: string;
  onUnsplashKeyChange: (value: string) => void;
}
export default function CategoryDiscovery({
  onSourceChange, onSaveToLibrary, serpapiKey, onSerpapiKeyChange,
  unsplashKey, onUnsplashKeyChange,
}: Props) {
  const [custom, setCustom] = useState<Category[]>(loadCustom);
  const [categoryId, setCategoryId] = useState("nature");
  const [topic, setTopic] = useState("All");
  const [keywords, setKeywords] = useState("");
  const [source, setSource] = useState<SourceChoice>("all");
  const [quality, setQuality] = useState<Quality>("all");
  const [results, setResults] = useState<Result[]>([]);
  const [review, setReview] = useState<CatalogImage[]>([]);
  const [inspected, setInspected] = useState<CatalogImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const requestId = useRef(0);
  const categories = [...PRIMARY, ...custom];
  const selected = categories.find((item) => item.id === categoryId) || PRIMARY[0];

  function saveCustom(next: Category[]) {
    setCustom(next);
    try { window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); }
    catch { /* Categories still work in this session. */ }
  }

  function addReview(photo: CatalogImage) {
    setReview((list) => {
      const key = imageKey(photo);
      return list.some((entry) => imageKey(entry) === key) || list.length >= 30
        ? list : [...list, photo];
    });
  }

  async function load(nextCategory: Category, nextTopic: string, selectedSource: SourceChoice = source,
    searchText: string = keywords) {
    const request = ++requestId.current;
    setLoading(true);
    setErrors([]);
    setNote("");
    setResults([]);
    const query = [nextCategory.prompt, nextTopic === "All" ? "" : nextTopic, searchText.trim()]
      .filter(Boolean).join(" ").slice(0, 100);
    const providers: SourceChoice[] = selectedSource === "all"
      ? ["commons", ...(nextCategory.id === "space" || nextCategory.id === "earth" ? ["nasa" as const] : []),
          ...(unsplashKey.trim() ? ["unsplash" as const] : []),
          ...(serpapiKey.trim() ? ["google" as const] : [])]
      : [selectedSource];
    const requests = providers.map((provider): Promise<CatalogResponse> => {
      if (provider === "google") {
        if (!serpapiKey.trim()) return Promise.reject(new Error("Google Images requires a SerpApi key. Or open the existing Google browser, which needs no key."));
        return browseGoogleImages(query, serpapiKey, 1920, 1080);
      }
      if (provider === "unsplash" && !unsplashKey.trim()) {
        return Promise.reject(new Error("Enter your Unsplash access key before using this source."));
      }
      if (provider === "commons" || provider === "nasa" || provider === "unsplash") {
        return browseCategoryImages(provider, query, unsplashKey);
      }
      return Promise.reject(new Error("Unsupported image source."));
    });
    const completed = await Promise.allSettled(requests);
    if (requestId.current !== request) return;
    const found: Result[] = [];
    const failures: string[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < completed.length; i++) {
      const outcome = completed[i];
      if (outcome.status === "rejected") {
        failures.push(SOURCE_OPTIONS.find((opt) => opt.id === providers[i])?.label + ": " +
          (outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)));
        continue;
      }
      notes.push(outcome.value.note);
      for (const photo of outcome.value.items) {
        const key = imageKey(photo);
        if (!key.startsWith("https://") || seen.has(key)) continue;
        seen.add(key);
        found.push({ key, photo });
      }
    }
    found.sort((a, b) => {
      const pixelsA = a.photo.width * a.photo.height;
      const pixelsB = b.photo.width * b.photo.height;
      return pixelsB - pixelsA;
    });
    setResults(found);
    setErrors(failures);
    setNote(notes.join(" · "));
    setLoading(false);
  }

  // Opening Discover is an intentional browsing action. No search occurs in
  // the background after leaving this screen; keys are never persisted.
  useEffect(() => {
    void load(PRIMARY[0], "All", "all", "");
    return () => { requestId.current++; };
  }, []);

  function chooseCategory(category: Category) {
    setCategoryId(category.id);
    setTopic("All");
    setKeywords("");
    void load(category, "All", source, "");
  }
  function chooseTopic(value: string) {
    setTopic(value);
    void load(selected, value);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load(selected, topic);
  }
  function addCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim().slice(0, 36);
    const prompt = newKeywords.trim().slice(0, 100);
    if (name.length < 2 || prompt.length < 2 || custom.length >= 12) return;
    const cat: Category = {
      id: "custom-" + Date.now().toString(36), name, prompt, icon: "✧",
      description: "Your own search topic", topics: ["All"], custom: true,
    };
    saveCustom([...custom, cat]);
    setNewName(""); setNewKeywords(""); setCreating(false);
    chooseCategory(cat);
  }
  const filtered = results.filter(({ photo }) => passesQuality(photo, quality));
  const included = (photo: CatalogImage) => review.some((item) => imageKey(item) === imageKey(photo));

  return (
    <section className="cdy-page">
      <div className="eyebrow">Haven Walls / Gallery</div>
      <header className="cdy-header">
        <div>
          <h1>Discover by Category</h1>
          <p>Explore high-quality wallpaper photography from free and optional sources.</p>
        </div>
        <span className="cdy-header-mark">Category discovery · PR #4</span>
      </header>
      <div className="cdy-source-nav" aria-label="Wallpaper discovery views">
        <button type="button" className="active">Discover by Category</button>
        <button type="button" onClick={() => onSourceChange("google")}>Google Images / Lens</button>
        <button type="button" onClick={() => onSourceChange("bing")}>Bing Daily</button>
        <button type="button" onClick={() => onSourceChange("sports")}>Sports sources</button>
        <button type="button" onClick={() => onSourceChange("tmdb")}>TV backdrops</button>
      </div>
      <div className="cdy-notice">Photos come from their respective providers. Reported resolution and usage rights
        need checking before importing. No images are saved until you choose them.</div>

      <section className="cdy-categories" aria-labelledby="cdy-category-title">
        <div className="cdy-heading">
          <div><h2 id="cdy-category-title">Choose a category</h2>
            <p>One click loads fresh suggestions from enabled sources.</p></div>
          <button type="button" className="cdy-outline" onClick={() => setCreating(true)}>
            + Custom category
          </button>
        </div>
        <div className="cdy-category-grid">
          {categories.map((category) => (
            <button type="button" key={category.id}
              className={"cdy-category cat-" + (category.custom ? "custom" : category.id) +
                (selected.id === category.id ? " active" : "")}
              aria-pressed={selected.id === category.id}
              onClick={() => chooseCategory(category)}>
              <span className="cdy-category-icon">{category.icon}</span>
              <strong>{category.name}</strong>
              <small>{category.description}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="cdy-heading cdy-results-title">
        <div><span className="eyebrow">Discover / {selected.name}</span>
          <h2>{selected.name} wallpapers</h2>
          <p>Choose a topic, inspect the image, then add it to Review selection.</p></div>
        {selected.custom && <button type="button" className="cdy-delete"
          onClick={() => { saveCustom(custom.filter((item) => item.id !== selected.id)); chooseCategory(PRIMARY[0]); }}>
          Delete custom category
        </button>}
      </div>
      <div className="cdy-topics" role="group" aria-label="Category topics">
        {selected.topics.map((value) => <button key={value} type="button"
          className={topic === value ? "active" : ""}
          aria-pressed={topic === value} onClick={() => chooseTopic(value)}>{value}</button>)}
      </div>

      <form className="cdy-filters" onSubmit={submit}>
        <label className="cdy-query"><span>Search within category</span>
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)}
            placeholder={"e.g. " + selected.prompt} maxLength={80} />
        </label>
        <label><span>Quality (reported)</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
            <option value="all">All sizes</option>
            <option value="1080p">1080p+</option>
            <option value="4k">4K+</option>
          </select>
        </label>
        <label><span>Image source</span>
          <select value={source} onChange={(e) => setSource(e.target.value as SourceChoice)}>
            {SOURCE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <button type="submit" className="cdy-primary" disabled={loading}>
          {loading ? "Searching…" : "Search / refresh"}
        </button>
      </form>
      <details className="cdy-keys">
        <summary>Optional provider API keys (session only)</summary>
        <div className="cdy-key-grid">
          <label>SerpApi key for Google Images
            <input type="password" autoComplete="off" value={serpapiKey}
              onChange={(e) => onSerpapiKeyChange(e.target.value)}
              placeholder="Optional Google Images API search" />
          </label>
          <label>Unsplash access key
            <input type="password" autoComplete="off" value={unsplashKey}
              onChange={(e) => onUnsplashKeyChange(e.target.value)}
              placeholder="Optional Unsplash photo search" />
          </label>
        </div>
        <p>Keys stay in app memory and go only to their respective provider when you search. NASA and Commons need no key. Google Browser Search also needs no key.</p>
      </details>

      {errors.length > 0 && <div className="cdy-errors" role="alert">
        {errors.map((message, index) => <p key={index}>{message}</p>)}
      </div>}
      {note && <p className="cdy-source-note">{note}</p>}

      <div className="cdy-workbench">
        <section className="cdy-catalog" aria-label="Discovered wallpapers">
          <div className="cdy-gallery-head">
            <strong>{loading ? "Loading wallpaper suggestions…" : filtered.length + " results"}</strong>
            <span>Original image resolution is verified during inspection/import</span>
          </div>
          {loading ? <div className="cdy-empty" role="status">Searching enabled photo sources…</div>
            : filtered.length === 0 ? <div className="cdy-empty">
              No matching photos returned. Try another topic, All sizes, a different provider, or a Google Images browser search.
              <button type="button" onClick={() => onSourceChange("google")}>Open Google Images</button>
            </div> : (
              <div className="cdy-image-grid">
                {filtered.map(({ key, photo }) => (
                  <article key={key} className="cdy-tile">
                    <button className="cdy-image-button" type="button" onClick={() => setInspected(photo)}
                      title={"Inspect " + photo.title}>
                      <img src={photo.previewUrl} alt={photo.title} loading="lazy" referrerPolicy="no-referrer"/>
                      <span>{displayQuality(photo)}</span>
                    </button>
                    <div className="cdy-tile-meta">
                      <strong title={photo.title}>{photo.title}</strong>
                      <small>{photo.source}{photo.credit ? " · " + photo.credit : ""}</small>
                      <div className="cdy-tile-actions">
                        <button type="button" className="cdy-outline" onClick={() => setInspected(photo)}>Inspect</button>
                        <button type="button" className="cdy-primary" disabled={included(photo)}
                          onClick={() => addReview(photo)}>{included(photo) ? "Added" : "+ Review"}</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
        </section>
        <aside className="cdy-review" aria-label="Review selection">
          <div className="cdy-review-heading"><strong>Review selection</strong><span>{review.length} / 30</span></div>
          <p>Choose photos to inspect before saving to your local Library.</p>
          {review.length === 0 ? <div className="cdy-review-empty">No wallpapers selected yet.</div> : (
            <div className="cdy-review-list">
              {review.map((photo) => <div key={imageKey(photo)} className="cdy-review-row">
                <img src={photo.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                <span title={photo.title}>{photo.title}</span>
                <button type="button" aria-label={"Remove " + photo.title}
                  onClick={() => setReview((existing) => existing.filter((item) =>
                    imageKey(item) !== imageKey(photo)))}>×</button>
              </div>)}
            </div>
          )}
          <button type="button" className="cdy-primary cdy-save" disabled={review.length === 0}
            onClick={() => onSaveToLibrary(review)}>Save selected to Library</button>
          <button type="button" className="cdy-clear" disabled={review.length === 0}
            onClick={() => setReview([])}>Clear selection</button>
          <p className="cdy-review-footnote">Library verifies image bytes, minimum resolution,
            duplicates and source restrictions. No automatic wallpaper rotation in PR #4.</p>
        </aside>
      </div>

      {inspected && <FullResolutionPreview image={inspected} onClose={() => setInspected(null)}
        addLabel="Add to Review" onAddToLibrary={(photo) => {
          addReview(photo); setInspected(null);
        }} />}

      {creating && <div className="cdy-modal-backdrop" onMouseDown={(e) => {
        if (e.target === e.currentTarget) setCreating(false);
      }}>
        <form className="cdy-modal" onSubmit={addCustom} role="dialog"
          aria-modal="true" aria-label="Create custom category">
          <h2>Create a category</h2>
          <p>Custom categories use your search keywords, with the same enabled sources and review flow.</p>
          <label>Category name<input value={newName} maxLength={36}
            onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Cars" autoFocus required /></label>
          <label>Search keywords<input value={newKeywords} maxLength={100}
            onChange={(e) => setNewKeywords(e.target.value)}
            placeholder="e.g. classic sports cars photography" required /></label>
          <div className="cdy-modal-actions">
            <button type="button" className="cdy-outline" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="cdy-primary"
              disabled={newName.trim().length < 2 || newKeywords.trim().length < 2 || custom.length >= 12}>
              Create category
            </button>
          </div>
        </form>
      </div>}
    </section>
  );
}
