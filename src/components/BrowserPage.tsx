import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_HOME, BROWSER_MAX_TABS, browserAddress, browserCloseTab,
  browserNavigateTab, browserOpenTab, browserShowTab, browserTabAction,
  browserTabState, browserLoadData, browserSaveSession, browserScanImages, browserSetZoom,
  type BrowserBounds, type BrowserNavigationEvent,
  type BrowserPopupEvent, type BrowserTabState, type BrowserAction,
  type BrowserBookmark, type BrowserVisit,
  type BrowserImagePicked, type BrowserScannedImage, type BrowserScanResponse, type BrowserScanError,
  type BrowserZoomEvent,
} from "../lib/browserNative";
import "./BrowserPage.css";
import BrowserDataPanel from "./BrowserDataPanel";
import BrowserImagePanel from "./BrowserImagePanel";
import FullResolutionPreview from "./FullResolutionPreview";
import { chooseOriginalFromLink, unwrapKnownImageLink, validRemoteUrl } from "../lib/imageResolution";
import type { CatalogImage } from "../lib/native";

interface Tab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  zoom: number;
}
const createId = () => "t-" + Math.random().toString(36).slice(2, 11);
const defaultTab = (): Tab => ({
  id: createId(), url: BROWSER_HOME, title: "Google",
  loading: false, back: false, forward: false, zoom: 100,
});
function describeUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") || "New tab"; }
  catch { return "New tab"; }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function BrowserPage({ active }: { active: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>(() => [defaultTab()]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [address, setAddress] = useState(BROWSER_HOME);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Ready to browse");
  const [ready, setReady] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [history, setHistory] = useState<BrowserVisit[]>([]);
  const [panel, setPanel] = useState<"bookmarks" | "history" | "save" | null>(null);
  const [sideTab, setSideTab] = useState<"found" | "review">("review");
  const [sideWidth, setSideWidth] = useState(392);
  const [scanBusy, setScanBusy] = useState(false);
  // Image candidates belong to the page in the particular tab that was scanned.
  // They are not persisted, and are never automatically reused for a new URL.
  const [scansByTab, setScansByTab] = useState<Record<string, BrowserScanResponse>>({});
  const [review, setReview] = useState<CatalogImage[]>([]);
  const [inspect, setInspect] = useState<CatalogImage | null>(null);
  const [captureNote, setCaptureNote] = useState("");
  const slotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const appliedZoomRef = useRef(new Map<string, number>());
  const inputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(new Set<string>());
  const frameRef = useRef<number | null>(null);
  // Native WebView2 commands must execute in display order; otherwise a slow
  // create from tab A can cover tab B after rapid tab switching.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const tabsRef = useRef(tabs);
  const activeRef = useRef(active);
  const selectedRef = useRef(selectedId);
  const readyRef = useRef(ready);
  const panelRef = useRef(panel);
  const inspectRef = useRef(inspect);
  const scanRequestRef = useRef<string | null>(null);
  tabsRef.current = tabs;
  activeRef.current = active;
  selectedRef.current = selectedId;
  readyRef.current = ready;
  panelRef.current = panel;
  inspectRef.current = inspect;

  // Read the previous session before opening a native WebView2 child.
  // Only the restored selected tab loads; other tabs remain metadata.
  useEffect(() => {
    let mounted = true;
    if (!isTauri()) {
      const first = tabsRef.current[0];
      selectedRef.current = first.id;
      setSelectedId(first.id);
      setReady(true);
      return;
    }
    void browserLoadData().then((data) => {
      if (!mounted) return;
      const restored = data.session?.tabs?.length
        ? data.session.tabs.map((tab) => ({
            ...tab, zoom: typeof tab.zoom === "number" && Number.isInteger(tab.zoom)
              ? Math.max(50, Math.min(200, tab.zoom)) : 100,
            loading: false, back: false, forward: false,
          }))
        : [defaultTab()];
      const chosen = restored.find((tab) => tab.id === data.session?.selectedId) ?? restored[0];
      loadedRef.current.clear();
      appliedZoomRef.current.clear();
      tabsRef.current = restored;
      selectedRef.current = chosen.id;
      setTabs(restored);
      setSelectedId(chosen.id);
      setAddress(chosen.url);
      setBookmarks(data.bookmarks);
      setHistory(data.history);
      setStatus(data.session ? "Previous tabs restored" : "Ready to browse");
    }).catch((problem: unknown) => {
      if (!mounted) return;
      const first = tabsRef.current[0];
      selectedRef.current = first.id;
      setSelectedId(first.id);
      setError("Could not restore browser tabs: " + message(problem));
    }).finally(() => {
      if (mounted) setReady(true);
    });
    return () => { mounted = false; };
  }, []);

  // Serialize saves so old navigation state cannot overwrite a
  // newer session. SQLite uses the existing app-owned data folder.
  useEffect(() => {
    if (!ready || !isTauri() || !selectedId) return;
    const session = {
      selectedId,
      tabs: tabs.map(({ id, url, title, zoom }) => ({
        id, url, title: title.slice(0, 180), zoom,
      })),
    };
    // Save promptly after navigation, selection or closure instead of waiting
    // for a debounce that could expire after the app is already closed.
    saveQueueRef.current = saveQueueRef.current
      .then(() => browserSaveSession(session))
      .catch((problem: unknown) => setError("Could not save browser tabs: " + message(problem)));
  }, [ready, selectedId, tabs]);

  const current = tabs.find((tab) => tab.id === selectedId) ?? tabs[0];
  const lastScan = selectedId ? scansByTab[selectedId] : undefined;
  const scanData = lastScan?.pageUrl === current?.url ? lastScan : null;

  function measure(): BrowserBounds | null {
    const slot = slotRef.current;
    if (!slot || !activeRef.current || !readyRef.current || panelRef.current || inspectRef.current) return null;
    const rect = slot.getBoundingClientRect();
    const width = Math.floor(Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.floor(Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
    if (width < 100 || height < 90) return null;
    return {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width, height,
    };
  }

  function enqueue(task: () => Promise<void>): void {
    const next = queueRef.current.then(task, task);
    queueRef.current = next.catch((problem: unknown) => setError(message(problem)));
  }

  function syncNative() {
    if (!isTauri()) return;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const id = activeRef.current && readyRef.current && !panelRef.current && !inspectRef.current
        ? selectedRef.current : null;
      const bounds = measure();
      enqueue(async () => {
        if (!id || !bounds) {
          await browserShowTab();
          return;
        }
        const tab = tabsRef.current.find((item) => item.id === id);
        if (!tab) return;
        if (loadedRef.current.has(id)) {
          await browserShowTab(id, bounds);
        } else {
          await browserOpenTab(id, tab.url, bounds);
          loadedRef.current.add(id);
        }
        if (appliedZoomRef.current.get(id) !== tab.zoom) {
          await browserSetZoom(id, tab.zoom);
          appliedZoomRef.current.set(id, tab.zoom);
        }
      });
    });
  }

  useEffect(() => {
    syncNative();
  }, [active, selectedId, ready, panel, inspect]);

  useEffect(() => {
    if (!isTauri()) return;
    const observer = new ResizeObserver(() => syncNative());
    if (slotRef.current) observer.observe(slotRef.current);
    const resized = () => syncNative();
    window.addEventListener("resize", resized);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resized);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // All browser children remain in memory while switching app sections.
      void browserShowTab().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let subscribed = true;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listen<BrowserNavigationEvent>("haven-browser-navigation", (event) => {
        const update = event.payload;
        if (!tabsRef.current.some((tab) => tab.id === update.tabId)) return;
        setTabs((old) => old.map((tab) => tab.id === update.tabId ? {
          ...tab,
          url: update.url ?? tab.url,
          title: update.title?.trim() || tab.title,
          loading: update.loading ?? tab.loading,
        } : tab));
        if (selectedRef.current === update.tabId && update.url
            && document.activeElement !== inputRef.current) setAddress(update.url);
        if (selectedRef.current === update.tabId) {
          setStatus(update.loading === true ? "Loading website…" : "Ready to browse");
        }
        if (update.loading === false) {
          void browserTabState(update.tabId).then((result) => {
            setTabs((old) => old.map((tab) => tab.id === update.tabId ? {
              ...tab, back: result.canGoBack, forward: result.canGoForward,
            } : tab));
          }).catch(() => {});
        }
      }),
      listen<BrowserZoomEvent>("haven-browser-zoom", ({ payload }) => {
        if (!Number.isInteger(payload.percent) || payload.percent < 50 || payload.percent > 200) return;
        if (!tabsRef.current.some((tab) => tab.id === payload.tabId)) return;
        appliedZoomRef.current.set(payload.tabId, payload.percent);
        setTabs((previous) => previous.map((tab) => tab.id === payload.tabId && tab.zoom !== payload.percent
          ? { ...tab, zoom: payload.percent } : tab));
      }),
      listen<BrowserImagePicked>("haven-browser-image-picked", (event) => {
        const selected = event.payload;
        if (!tabsRef.current.some((tab) => tab.id === selected.tabId)) return;
        const imageUrl = validRemoteUrl(selected.imageUrl);
        const linkUrl = validRemoteUrl(selected.linkUrl);
        // A publisher-page link alone must never be treated as an image.
        // The only link-only fallback is a Google imgres URL that explicitly
        // embeds a distinct, valid original image address.
        const unwrapped = linkUrl ? unwrapKnownImageLink(linkUrl) : null;
        const linkImage = unwrapped && unwrapped !== linkUrl ? unwrapped : null;
        if (!imageUrl && !linkImage) {
          setError("This selection provided a publisher link, not a direct image. Try Find images.");
          return;
        }
        const resolved = chooseOriginalFromLink(imageUrl || linkImage || "", linkUrl || undefined);
        const best = validRemoteUrl(resolved.original);
        if (!best) {
          setError("The selected image did not expose a usable HTTPS image URL. Try Find images.");
          return;
        }
        const title = (() => {
          try {
            return decodeURIComponent(new URL(best).pathname.split("/").pop()
              || "Website image").slice(0, 120);
          } catch { return "Website image"; }
        })();
        const item = makeImage(imageUrl || best, selected.pageUrl, title, 0, 0, best);
        if (item) {
          addReview([item]);
          setSideTab("review");
        } else setError("Could not verify an image URL from this website.");
      }),
      listen<BrowserScanResponse>("haven-browser-scan-results", (event) => {
        const result = event.payload;
        if (scanRequestRef.current !== result.tabId) return;
        scanRequestRef.current = null;
        setScanBusy(false);
        if (selectedRef.current !== result.tabId) {
          setCaptureNote("Background-tab scan finished. Select that tab to view its results.");
          setScansByTab((previous) => ({ ...previous, [result.tabId]: result }));
          return;
        }
        setScansByTab((previous) => ({ ...previous, [result.tabId]: result }));
        setPanel(null);
        setSideTab("found");
        setCaptureNote(result.images.length
          + " image candidates found. Select and inspect the ones you want.");
      }),
      listen<BrowserScanError>("haven-browser-scan-error", (event) => {
        if (scanRequestRef.current !== event.payload.tabId) return;
        scanRequestRef.current = null;
        setScanBusy(false);
        setError(event.payload.message);
      }),
      listen<string>("haven-browser-image-error", (event) => {
        setError(event.payload);
      }),
      listen<BrowserPopupEvent>("haven-browser-popup", (event) => {
        if (!tabsRef.current.some((tab) => tab.id === event.payload.openerId)) return;
        if (tabsRef.current.length >= BROWSER_MAX_TABS) {
          setError("Tab limit reached. Close a tab before opening another website.");
          return;
        }
        openTab(event.payload.url);
      }),
    ]).then((items) => {
      if (subscribed) unlisteners.push(...items);
      else items.forEach((dispose) => dispose());
    }).catch((problem: unknown) => { if (subscribed) setError(message(problem)); });
    return () => { subscribed = false; unlisteners.forEach((dispose) => dispose()); };
  }, []);

  function openTab(url = BROWSER_HOME) {
    if (tabsRef.current.length >= BROWSER_MAX_TABS) {
      setError("You can open up to 12 browser tabs.");
      return;
    }
    const tab: Tab = {
      id: createId(), url, title: describeUrl(url), loading: false,
      back: false, forward: false, zoom: 100,
    };
    tabsRef.current = [...tabsRef.current, tab];
    setTabs(tabsRef.current);
    selectedRef.current = tab.id;
    setSelectedId(tab.id);
    setAddress(url);
    setPanel(null);
    setError("");
  }

  function selectTab(tab: Tab) {
    selectedRef.current = tab.id;
    setSelectedId(tab.id);
    setAddress(tab.url);
    setPanel(null);
    setError("");
  }

  function closeTab(id: string) {
    const existing = tabsRef.current;
    const idx = existing.findIndex((tab) => tab.id === id);
    if (idx < 0) return;
    let remaining = existing.filter((tab) => tab.id !== id);
    if (remaining.length === 0) remaining = [defaultTab()];
    tabsRef.current = remaining;
    setTabs(remaining);
    if (selectedRef.current === id) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      selectedRef.current = next.id;
      setSelectedId(next.id);
      setAddress(next.url);
    }
    loadedRef.current.delete(id);
    appliedZoomRef.current.delete(id);
    setScansByTab((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    enqueue(() => browserCloseTab(id));
    setError("");
  }

  function visit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = selectedRef.current;
    if (!id) return;
    try {
      const url = browserAddress(address);
      setError("");
      setTabs((old) => old.map((tab) => tab.id === id
        ? { ...tab, url, loading: true, title: describeUrl(url) } : tab));
      setAddress(url);
      enqueue(async () => {
        // Creation may still be in progress. Queue guarantees ordering.
        if (loadedRef.current.has(id)) {
          await browserNavigateTab(id, url);
        } else {
          const bounds = measure();
          if (!bounds) throw new Error("Browser area is not visible.");
          await browserOpenTab(id, url, bounds);
          loadedRef.current.add(id);
        }
      });
    } catch (problem) {
      setError(message(problem));
    }
  }

  function navigate(action: BrowserAction) {
    const id = selectedRef.current;
    if (!id || !loadedRef.current.has(id)) return;
    enqueue(async () => {
      const result = await browserTabAction(id, action);
      updateState(id, result);
    });
  }

  function updateState(id: string, state: BrowserTabState) {
    setTabs((old) => old.map((tab) => tab.id === id ? {
      ...tab, url: state.url, back: state.canGoBack, forward: state.canGoForward,
    } : tab));
    if (selectedRef.current === id && document.activeElement !== inputRef.current) {
      setAddress(state.url);
    }
  }

  function home() {
    const id = selectedRef.current;
    if (!id) return;
    setAddress(BROWSER_HOME);
    enqueue(async () => {
      if (loadedRef.current.has(id)) await browserNavigateTab(id, BROWSER_HOME);
      else {
        const bounds = measure();
        if (bounds) {
          await browserOpenTab(id, BROWSER_HOME, bounds);
          loadedRef.current.add(id);
        }
      }
    });
  }


  function togglePanel(next: "bookmarks" | "history") {
    setPanel((current) => current === next ? null : next);
    void browserLoadData().then((data) => {
      setBookmarks(data.bookmarks);
      setHistory(data.history);
    }).catch((problem: unknown) => setError(message(problem)));
  }

  function openSavedWebsite(url: string, newTab: boolean) {
    setPanel(null);
    if (newTab) { openTab(url); return; }
    const id = selectedRef.current;
    if (!id) return;
    setAddress(url);
    setTabs((old) => old.map((tab) => tab.id === id
      ? { ...tab, url, title: describeUrl(url), loading: true } : tab));
    // Closing the panel triggers the native show/create effect on the next
    // React render. Do not try measuring a still-hidden WebView2 slot here.
    if (loadedRef.current.has(id)) {
      enqueue(() => browserNavigateTab(id, url));
    }
  }


  // Native image selection is only metadata; originals are checked through
  // the existing FullResolutionPreview before any future Library import.
  function makeImage(
    url: string, pageUrl: string, title: string, width: number, height: number,
    original?: string | null,
  ): CatalogImage | null {
    const direct = validRemoteUrl(url);
    if (!direct) return null;
    const chosen = original ? chooseOriginalFromLink(direct, original) : null;
    const best = (chosen?.original && validRemoteUrl(chosen.original)) || direct;
    const page = validRemoteUrl(pageUrl) || "";
    const label = title.slice(0, 150) || "Website image";
    return {
      id: "browser-" + best,
      source: "Haven Walls Browser",
      title: label,
      previewUrl: direct,
      originalUrl: best,
      candidateUrls: direct !== best ? [direct] : [],
      pageUrl: page,
      credit: "Image hosted by " + new URL(best).hostname + " · Creator unverified",
      rights: "Found on a website. Image rights and attribution have not been verified.",
      width, height, kind: "image",
    };
  }

  function fromScanned(item: BrowserScannedImage): CatalogImage | null {
    return makeImage(item.url, scanData?.pageUrl || current?.url || "",
      item.title, item.width, item.height, item.originalUrl);
  }

  function addReview(candidates: CatalogImage[]) {
    setReview((previous) => {
      const seen = new Set(previous.map((item) => item.originalUrl || item.previewUrl));
      const next = [...previous];
      for (const candidate of candidates) {
        const key = candidate.originalUrl || candidate.previewUrl;
        if (next.length >= 30) break;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(candidate);
        }
      }
      return next;
    });
    setCaptureNote("Image selection updated. Inspect your candidates before saving.");
  }

  function scanPage() {
    const id = selectedRef.current;
    if (!id || !loadedRef.current.has(id) || scanBusy) {
      setError("Open a website in the selected tab before scanning.");
      return;
    }
    scanRequestRef.current = id;
    setPanel(null);
    setScanBusy(true);
    setError("");
    setCaptureNote("");
    void browserScanImages(id).catch((cause: unknown) => {
      if (scanRequestRef.current === id) {
        scanRequestRef.current = null;
        setScanBusy(false);
        setError("Could not scan this website: " + message(cause));
      }
    });
  }


  function changeZoom(requested: number) {
    const id = selectedRef.current;
    if (!id) return;
    const percent = Math.max(50, Math.min(200, Math.round(requested / 10) * 10));
    setTabs((before) => before.map((tab) => tab.id === id ? { ...tab, zoom: percent } : tab));
    if (loadedRef.current.has(id)) {
      enqueue(async () => {
        await browserSetZoom(id, percent);
        appliedZoomRef.current.set(id, percent);
      });
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, width: sideWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const room = bodyRef.current?.clientWidth ?? 1100;
    const maximum = Math.max(300, Math.min(700, Math.floor(room * 0.62)));
    setSideWidth(Math.max(300, Math.min(maximum, drag.width + drag.x - event.clientX)));
  }
  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function shortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "+" || key === "=" || key === "add") {
      event.preventDefault();
      changeZoom((current?.zoom ?? 100) + 10);
    } else if (key === "-" || key === "subtract") {
      event.preventDefault();
      changeZoom((current?.zoom ?? 100) - 10);
    } else if (key === "0") {
      event.preventDefault();
      changeZoom(100);
    } else if (key === "l") {
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (key === "t") {
      event.preventDefault();
      openTab();
    } else if (key === "w") {
      event.preventDefault();
      if (selectedRef.current) closeTab(selectedRef.current);
    } else if (key === "tab") {
      event.preventDefault();
      const currentIndex = tabsRef.current.findIndex((tab) => tab.id === selectedRef.current);
      const index = (currentIndex + (event.shiftKey ? -1 : 1) + tabsRef.current.length) % tabsRef.current.length;
      selectTab(tabsRef.current[index]);
    }
  }

  return (
    <section className="hw-browser" aria-label="Haven Walls built-in browser"
      style={{ display: active ? "flex" : "none" }} onKeyDown={shortcut}>
      <header className="hw-browser-heading">
        <div>
          <div className="eyebrow">Haven Walls / Browser</div>
          <h1>Browse &amp; discover</h1>
          <p>Browse websites and compare their images in the Found / Review panel.</p>
        </div>
        <span className="hw-browser-stage">PR #5 · Commit 3</span>
      </header>
      <div className="hw-browser-frame">
        <nav className="hw-browser-tabs" aria-label="Website tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={"hw-browser-tab" + (selectedId === tab.id ? " selected" : "")}>
              <button type="button" className="hw-browser-tab-name"
                onClick={() => selectTab(tab)}
                aria-current={selectedId === tab.id ? "page" : undefined}
                title={tab.title + "\n" + tab.url}>
                <span className="hw-browser-favicon" aria-hidden="true">{tab.loading ? "◌" : "◉"}</span>
                <span className="hw-browser-tab-label">{tab.title}</span>
              </button>
              <button type="button" className="hw-browser-tab-close"
                aria-label={"Close " + tab.title} title="Close tab"
                onClick={() => closeTab(tab.id)}>×</button>
            </div>
          ))}
          <button className="hw-browser-add-tab" type="button" title="New Google tab"
            disabled={tabs.length >= BROWSER_MAX_TABS} onClick={() => openTab()}>＋</button>
          <span className="hw-browser-tab-count">{tabs.length} {tabs.length === 1 ? "tab" : "tabs"}</span>
        </nav>
        <div className="hw-browser-toolbar" aria-label="Browser navigation">
          <button type="button" className="hw-browser-icon-button"
            disabled={!current?.back} title="Back" onClick={() => navigate("back")}>‹</button>
          <button type="button" className="hw-browser-icon-button"
            disabled={!current?.forward} title="Forward" onClick={() => navigate("forward")}>›</button>
          <button type="button" className="hw-browser-icon-button"
            title="Reload page" onClick={() => navigate("reload")}>↻</button>
          <button type="button" className="hw-browser-icon-button"
            title="Google homepage" onClick={home}>⌂</button>
          <form className="hw-browser-address-form" onSubmit={visit}>
            <span aria-hidden="true">⌕</span>
            <input ref={inputRef} type="text" value={address} spellCheck={false}
              onChange={(event) => setAddress(event.target.value)}
              aria-label="Search Google or enter website address"
              placeholder="Search Google or enter a website address"/>
            <button type="submit" title="Go to address">Go</button>
          </form>
          <div className="hw-browser-zoom" role="group" aria-label="Website zoom">
            <button type="button" aria-label="Zoom website out" title="Zoom out (Ctrl+-)"
              disabled={!ready || (current?.zoom ?? 100) <= 50}
              onClick={() => changeZoom((current?.zoom ?? 100) - 10)}>−</button>
            <button type="button" className="hw-browser-zoom-value"
              title="Reset this tab to 100% (Ctrl+0)"
              aria-label={"Reset website zoom from " + (current?.zoom ?? 100) + "% to 100%"}
              onClick={() => changeZoom(100)}>{current?.zoom ?? 100}%</button>
            <button type="button" aria-label="Zoom website in" title="Zoom in (Ctrl++)"
              disabled={!ready || (current?.zoom ?? 100) >= 200}
              onClick={() => changeZoom((current?.zoom ?? 100) + 10)}>+</button>
          </div>
          <button type="button" className="hw-browser-icon-button"
            title="Bookmark current page" aria-label="Bookmark current page"
            onClick={() => setPanel("save")}>{
              bookmarks.some((item) => item.url === current?.url) ? "★" : "☆"
            }</button>
          <button type="button" className={"hw-browser-icon-button" + (panel === "bookmarks" ? " hw-browser-active-icon" : "")}
            title="Bookmarks" aria-label="Bookmarks"
            onClick={() => togglePanel("bookmarks")}>☷</button>
          <button type="button" className={"hw-browser-icon-button" + (panel === "history" ? " hw-browser-active-icon" : "")}
            title="History" aria-label="History"
            onClick={() => togglePanel("history")}>◷</button>
          <button type="button" className="hw-browser-feature hw-browser-feature-live"
            disabled={!ready || scanBusy || !loadedRef.current.has(selectedId || "")}
            title="Scan this webpage for image candidates"
            onClick={scanPage}>{scanBusy ? "Finding…" : "▧ Find images"}</button>
          <button type="button" className="hw-browser-feature hw-browser-feature-live"
            title="Show selected images" onClick={() => { setPanel(null); setSideTab("review"); }}>
            Review · {review.length}
          </button>
        </div>
        <div className="hw-browser-notice" role="status">
          {error
            ? <span className="hw-browser-error">{error}</span>
            : <span>{captureNote || (ready
              ? "Right-click an image → Add to Haven Walls Review · Find images scans the current webpage"
              : "Restoring browser session…")}</span>}
        </div>
        <div ref={bodyRef} className="hw-browser-body">
          <div className="hw-browser-native-space">
            <div className="hw-browser-placeholder" aria-hidden="true">
              <span>◎</span>
              <strong>{isTauri() ? "Loading embedded website…" : "Browser requires Haven Walls for Windows"}</strong>
              <small>{isTauri()
                ? "Website pages render in the native WebView2 layer above this placeholder."
                : "Run the Tauri desktop application to open real websites."}</small>
            </div>
            <div ref={slotRef} className="hw-browser-native-slot" aria-label="Native WebView2 website content"/>
            {panel && current && (
              <BrowserDataPanel mode={panel} current={{ url: current.url, title: current.title }}
                bookmarks={bookmarks} history={history}
                onBookmarks={setBookmarks} onHistory={setHistory}
                onOpen={openSavedWebsite} onClose={() => setPanel(null)}/>
            )}

          </div>
          <div className="hw-browser-panel-resizer" role="separator"
            aria-label="Resize Found and Review panel" aria-orientation="vertical"
            aria-valuemin={300} aria-valuemax={700} aria-valuenow={sideWidth}
            tabIndex={0}
            onPointerDown={beginResize} onPointerMove={moveResize}
            onPointerUp={endResize} onPointerCancel={endResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setSideWidth((value) => Math.max(300, Math.min(700,
                  value + (event.key === "ArrowLeft" ? 30 : -30))));
              }
            }}/>
          <aside className="hw-browser-review" aria-label="Found images and Review selection"
            style={{ width: sideWidth }}>
            <div className="hw-browser-side-tabs" role="tablist" aria-label="Website images">
              <button type="button" role="tab" aria-selected={sideTab === "found"}
                className={sideTab === "found" ? "selected" : ""}
                onClick={() => setSideTab("found")}>Found
                <span>{scanData?.images.length ?? 0}</span>
              </button>
              <button type="button" role="tab" aria-selected={sideTab === "review"}
                className={sideTab === "review" ? "selected" : ""}
                onClick={() => setSideTab("review")}>Review
                <span>{review.length}/30</span>
              </button>
            </div>
            {sideTab === "found" ? (
              scanData ? (
                <BrowserImagePanel pageUrl={scanData.pageUrl} images={scanData.images}
                  skipped={scanData.skipped}
                  onInspect={(candidate) => {
                    const image = fromScanned(candidate);
                    if (image) setInspect(image);
                  }}
                  onAddToReview={(items) => {
                    addReview(items.flatMap((item) => {
                      const image = fromScanned(item);
                      return image ? [image] : [];
                    }));
                    setSideTab("review");
                  }}
                  onClose={() => setSideTab("review")}/>
              ) : (
                <div className="hw-browser-side-empty">
                  <strong>No images scanned for this page</strong>
                  <p>Keep browsing on the left. Click <b>Find images</b> to scan the current website.</p>
                </div>
              )
            ) : (
              <>
            <div className="hw-browser-review-title">
              <strong>Review selection</strong><span>{review.length} / 30</span>
            </div>
            <p>Right-click an image on any website, or use Find images to add multiple photos.</p>
            {review.length ? (
              <div className="hw-browser-review-list">
                {review.map((item) => (
                  <div className="hw-browser-review-item" key={item.id}>
                    <button type="button" title="Inspect image" onClick={() => setInspect(item)}>
                      <img src={item.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer"/>
                      <span>{item.title}</span>
                    </button>
                    <button type="button" title="Remove image"
                      onClick={() => setReview((old) =>
                        old.filter((candidate) => candidate.id !== item.id))}>×</button>
                  </div>
                ))}
              </div>
            ) : <div className="hw-browser-review-empty">No wallpapers selected yet.</div>}
            <div className="hw-browser-review-bottom">
              {review.length > 0 && <button type="button" className="hw-browser-review-clear"
                onClick={() => setReview([])}>Clear selection</button>}
              <button type="button" disabled>Save selected to Library</button>
              <small>Library import arrives in Commit 4. Inspect and image selection work now.</small>
            </div>
              </>
            )}
          </aside>
        </div>
        <footer className="hw-browser-footer">
          <span>{current?.loading ? "Loading…" : status} · Browser sessions survive restarts</span>
          <span>New tab: Ctrl+T · Address: Ctrl+L</span>
        </footer>
      </div>
      {inspect && (
        <FullResolutionPreview image={inspect} key={inspect.id}
          onClose={() => setInspect(null)}
          onAddToLibrary={(image) => {
            addReview([image]);
            setInspect(null);
          }}
          addLabel="Add to Review"/>
      )}
    </section>
  );
}
