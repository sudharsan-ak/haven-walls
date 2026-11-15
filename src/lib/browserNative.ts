import { invoke, isTauri } from "@tauri-apps/api/core";

export const BROWSER_HOME = "https://www.google.com/";
export const BROWSER_MAX_TABS = 12;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserNavigationEvent {
  tabId: string;
  url: string | null;
  title: string | null;
  loading: boolean | null;
}
export interface BrowserPopupEvent {
  openerId: string;
  url: string;
}
export interface BrowserTabState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}
export type BrowserAction = "back" | "forward" | "reload";

/** Address bar accepts a website URL or plain-text Google search.
 * The Rust command validates again before any native navigation.
 */
export function browserAddress(text: string): string {
  const input = text.trim();
  if (!input || input.length > 2048) throw new Error("Enter a website or search, up to 2,048 characters.");
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error("This address contains invalid characters.");
  let candidate: string | null = null;
  if (/^https?:\/\//i.test(input)) candidate = input;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(?:file|javascript|data|tauri|about):/i.test(input)) {
    throw new Error("Only regular HTTP and HTTPS websites can be opened.");
  } else if (!/\s/.test(input) && /^(?:localhost(?::\d+)?|(?:[\w-]+\.)+[\w-]{2,})(?:[/?#].*)?$/i.test(input)) {
    candidate = (input.startsWith("localhost") ? "http://" : "https://") + input;
  }
  if (candidate) {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error("Only regular HTTP and HTTPS websites can be opened.");
    }
    return url.toString();
  }
  const search = new URL("https://www.google.com/search");
  search.searchParams.set("q", input);
  return search.toString();
}

function nativeOnly(): void {
  if (!isTauri()) throw new Error("The Browser workspace requires the Haven Walls Windows app.");
}
export async function browserOpenTab(tabId: string, url: string, bounds: BrowserBounds): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_open_tab", { tabId, url, bounds });
}
export async function browserShowTab(tabId?: string, bounds?: BrowserBounds): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_show_tab", { tabId: tabId ?? null, bounds: bounds ?? null });
}
export async function browserNavigateTab(tabId: string, url: string): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_navigate_tab", { tabId, url });
}
export async function browserTabAction(tabId: string, action: BrowserAction): Promise<BrowserTabState> {
  nativeOnly();
  return invoke<BrowserTabState>("browser_tab_action", { tabId, action });
}
export async function browserTabState(tabId: string): Promise<BrowserTabState> {
  nativeOnly();
  return invoke<BrowserTabState>("browser_tab_state", { tabId });
}
export async function browserCloseTab(tabId: string): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_close_tab", { tabId });
}


/** Metadata lives in local SQLite; WebView2 manages cookies in browser-profile. */
export interface StoredBrowserTab {
  id: string;
  url: string;
  title: string;
  /** Percent zoom; missing in old browser sessions (defaults to 100). */
  zoom?: number;
}
export interface BrowserSession {
  selectedId: string;
  tabs: StoredBrowserTab[];
}
export interface BrowserBookmark {
  id: number;
  url: string;
  title: string;
  folder: string;
  createdAt: string;
}
export interface BrowserVisit {
  id: number;
  url: string;
  title: string;
  visitedAt: string;
}
export interface BrowserData {
  session: BrowserSession | null;
  bookmarks: BrowserBookmark[];
  history: BrowserVisit[];
}
export async function browserLoadData(): Promise<BrowserData> {
  nativeOnly();
  return invoke<BrowserData>("browser_load_data");
}
export async function browserSaveSession(session: BrowserSession): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_save_session", { session });
}
export async function browserAddBookmark(
  url: string, title: string, folder: string,
): Promise<BrowserBookmark[]> {
  nativeOnly();
  return invoke<BrowserBookmark[]>("browser_add_bookmark", { url, title, folder });
}
export async function browserRemoveBookmark(id: number): Promise<BrowserBookmark[]> {
  nativeOnly();
  return invoke<BrowserBookmark[]>("browser_remove_bookmark", { id });
}
export async function browserClearHistory(): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_clear_history");
}


/** WebView2 host-owned image scan. No native API is exposed to remote pages. */
export interface BrowserScannedImage {
  url: string;
  originalUrl: string | null;
  title: string;
  width: number;
  height: number;
}
export interface BrowserScanResponse {
  tabId: string;
  pageUrl: string;
  images: BrowserScannedImage[];
  skipped: number;
}
export interface BrowserScanError {
  tabId: string;
  message: string;
}
export interface BrowserImagePicked {
  tabId: string;
  imageUrl: string;
  pageUrl: string;
  linkUrl: string;
}
export async function browserScanImages(tabId: string): Promise<void> {
  nativeOnly();
  return invoke<void>("browser_scan_images", { tabId });
}

/** Changes only the specific native website WebView2, not the app UI. */
export async function browserSetZoom(tabId: string, percent: number): Promise<void> {
  nativeOnly();
  if (!Number.isInteger(percent) || percent < 50 || percent > 200) {
    throw new Error("Website zoom must be between 50% and 200%.");
  }
  return invoke<void>("browser_set_zoom", { tabId, percent });
}
export interface BrowserZoomEvent {
  tabId: string;
  percent: number;
}


/** Only external HTTP(S) page addresses belong in browser tab state.
 * WebView2 may briefly report about:blank or other internal URLs during
 * child initialization. These must never replace the user's last website.
 */
export function isBrowserPageUrl(value: string | null | undefined): value is string {
  if (!value || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
