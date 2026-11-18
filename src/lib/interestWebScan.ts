import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BrowserScanError, BrowserScanResponse } from "./browserNative";

/** The native scanner uses the same bounded DOM image extraction as Browser -> Find Images.
 * Search pages remain in an isolated hidden WebView2 and never replace the
 * user's visible Browser tabs or navigate away from Gallery.
 */
const RESULTS = "haven-interest-search-results";
const ERRORS = "haven-interest-search-error";
const TIMEOUT_MS = 28000;

export type InterestSearchMode = "browser" | "serpapi" | "both";
const PREF_KEY = "haven-walls.interest-image-search-mode.v1";

export function readInterestSearchMode(): InterestSearchMode {
  try {
    const mode = window.localStorage.getItem(PREF_KEY);
    return mode === "serpapi" || mode === "both" ? mode : "browser";
  } catch { return "browser"; }
}
export function saveInterestSearchMode(mode: InterestSearchMode): void {
  try { window.localStorage.setItem(PREF_KEY, mode); }
  catch { /* Retain this session's selection. */ }
}

export function googleImageSearchUrl(
  query: string,
  timeRange: "day" | "week" | "month" | "year" | "any" | "custom" = "any",
  dateFrom = "",
  dateTo = "",
): string {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("udm", "2");
  url.searchParams.set("safe", "active");
  const times: Record<string, string> = {
    day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y",
  };
  if (timeRange === "custom") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
      throw new Error("Set valid custom dates before searching.");
    }
    const googleDate = (iso: string) => {
      const [y, m, d] = iso.split("-");
      return Number(m) + "/" + Number(d) + "/" + y;
    };
    url.searchParams.set("tbs",
      "cdr:1,cd_min:" + googleDate(dateFrom) + ",cd_max:" + googleDate(dateTo));
  } else if (times[timeRange]) {
    url.searchParams.set("tbs", times[timeRange]);
  }
  return url.toString();
}

/** Sequential on-demand page scan with guaranteed listener and WebView cleanup.
 * AbortSignal is used when the user switches interests/tabs or leaves Gallery.
 */
export async function scanInterestSearchPage(
  pageUrl: string, searchId: string, signal?: AbortSignal,
  nativeQuery?: string,
): Promise<BrowserScanResponse> {
  if (!isTauri()) throw new Error("Website image scanning requires Haven Walls for Windows.");
  if (signal?.aborted) throw new Error("Search cancelled.");

  const dispose: UnlistenFn[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settle: ((outcome: BrowserScanResponse) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const response = new Promise<BrowserScanResponse>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  try {
    dispose.push(await listen<BrowserScanResponse>(RESULTS, (event) => {
      if (event.payload.tabId === searchId) settle?.(event.payload);
    }));
    dispose.push(await listen<BrowserScanError>(ERRORS, (event) => {
      if (event.payload.tabId === searchId) fail?.(new Error(event.payload.message));
    }));

    if (signal?.aborted) throw new Error("Search cancelled.");
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("This website did not finish scanning within 28 seconds.")),
        TIMEOUT_MS,
      );
    });
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("Search cancelled."));
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    // Start only after listening; very fast site loads must not lose events.
    await invoke<void>("start_interest_page_search", {
      searchId, url: pageUrl, nativeQuery: nativeQuery ?? null,
    });
    return await Promise.race([response, timeoutPromise, abortPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    dispose.forEach((unlisten) => unlisten());
    // Closing this one-off webview releases resources, even on timeout/error.
    await invoke<void>("close_interest_page_search", { searchId }).catch(() => {});
  }
}
