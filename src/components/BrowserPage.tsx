import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  BROWSER_HOME, BROWSER_MAX_TABS, browserAddress, browserCloseTab,
  browserNavigateTab, browserOpenTab, browserShowTab, browserTabAction,
  browserTabState, type BrowserBounds, type BrowserNavigationEvent,
  type BrowserPopupEvent, type BrowserTabState, type BrowserAction,
} from "../lib/browserNative";
import "./BrowserPage.css";

interface Tab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
}
const createId = () => "t-" + Math.random().toString(36).slice(2, 11);
const defaultTab = (): Tab => ({
  id: createId(), url: BROWSER_HOME, title: "Google",
  loading: false, back: false, forward: false,
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
  const slotRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(new Set<string>());
  const frameRef = useRef<number | null>(null);
  // Native WebView2 commands must execute in display order; otherwise a slow
  // create from tab A can cover tab B after rapid tab switching.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const tabsRef = useRef(tabs);
  const activeRef = useRef(active);
  const selectedRef = useRef(selectedId);
  tabsRef.current = tabs;
  activeRef.current = active;
  selectedRef.current = selectedId;

  // Initial tab ID is generated once; no website is loaded until Browser is opened.
  useEffect(() => {
    if (selectedRef.current === null && tabsRef.current[0]) {
      const first = tabsRef.current[0];
      selectedRef.current = first.id;
      setSelectedId(first.id);
    }
  }, []);

  const current = tabs.find((tab) => tab.id === selectedId) ?? tabs[0];

  function measure(): BrowserBounds | null {
    const slot = slotRef.current;
    if (!slot || !activeRef.current) return null;
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
      const id = activeRef.current ? selectedRef.current : null;
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
      });
    });
  }

  useEffect(() => {
    syncNative();
  }, [active, selectedId]);

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
      back: false, forward: false,
    };
    tabsRef.current = [...tabsRef.current, tab];
    setTabs(tabsRef.current);
    selectedRef.current = tab.id;
    setSelectedId(tab.id);
    setAddress(url);
    setError("");
  }

  function selectTab(tab: Tab) {
    selectedRef.current = tab.id;
    setSelectedId(tab.id);
    setAddress(tab.url);
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

  function shortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "l") {
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
          <p>Find wallpapers anywhere on the web. Image capture arrives in Commit 3.</p>
        </div>
        <span className="hw-browser-stage">PR #5 · Commit 1</span>
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
          <button type="button" className="hw-browser-icon-button hw-browser-future"
            title="Bookmarks arrive in Commit 2" disabled>☆</button>
          <button type="button" className="hw-browser-icon-button hw-browser-future"
            title="History arrives in Commit 2" disabled>◷</button>
          <button type="button" className="hw-browser-feature" disabled
            title="Find images on page arrives in Commit 3">▧ Find images</button>
          <button type="button" className="hw-browser-feature" disabled
            title="Review integration arrives in Commit 4">Review · 0</button>
        </div>
        <div className="hw-browser-notice" role="status">
          {error
            ? <span className="hw-browser-error">{error}</span>
            : <span>Real WebView2 website browsing · Tabs are session-only until Commit 2</span>}
        </div>
        <div className="hw-browser-body">
          <div className="hw-browser-native-space">
            <div className="hw-browser-placeholder" aria-hidden="true">
              <span>◎</span>
              <strong>{isTauri() ? "Loading embedded website…" : "Browser requires Haven Walls for Windows"}</strong>
              <small>{isTauri()
                ? "Website pages render in the native WebView2 layer above this placeholder."
                : "Run the Tauri desktop application to open real websites."}</small>
            </div>
            <div ref={slotRef} className="hw-browser-native-slot" aria-label="Native WebView2 website content"/>
          </div>
          <aside className="hw-browser-review" aria-label="Upcoming browser image review">
            <div className="hw-browser-review-title"><strong>Review selection</strong><span>0 / 30</span></div>
            <p>Browse now. Right-click capture and page scanning will be enabled in Commit 3.</p>
            <div className="hw-browser-review-empty">No wallpapers selected yet.</div>
            <div className="hw-browser-review-bottom">
              <button type="button" disabled>Save selected to Library</button>
              <small>Inspect → Review → Library arrives in Commit 4.</small>
            </div>
          </aside>
        </div>
        <footer className="hw-browser-footer">
          <span>{current?.loading ? "Loading…" : status} · Browser tabs stay open while switching sections</span>
          <span>New tab: Ctrl+T · Address: Ctrl+L</span>
        </footer>
      </div>
    </section>
  );
}
