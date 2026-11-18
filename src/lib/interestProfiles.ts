import {
  getPersonalization, saveFollowedInterest, type FollowedInterest,
  type InterestInput, type InterestKind,
} from "./personalization";
import { loadSportsLeagues, normalizeLeagueWebsite } from "./sportsLeagues";

export type SearchWindow = "day" | "week" | "month" | "year" | "any" | "custom";
export type WebsiteMode = "google" | "browser";
export interface InterestWebsite {
  host: string;
  mode: WebsiteMode;
}
export interface InterestPreferences {
  keyword: string;
  timeRange: SearchWindow;
  dateFrom: string;
  dateTo: string;
  googleEnabled: boolean;
  providerEnabled: boolean;
  inheritWebsites: boolean;
  websites: InterestWebsite[];
  exclusions: string;
  artwork: string[];
}

export const INTEREST_TYPES: { id: InterestKind; label: string; family: string }[] = [
  { id: "league", label: "League", family: "Sports" },
  { id: "team", label: "Team", family: "Sports" },
  { id: "player", label: "Player", family: "Sports" },
  { id: "tv", label: "TV show", family: "TV & Movies" },
  { id: "movie", label: "Movie", family: "TV & Movies" },
  { id: "place", label: "Place or topic", family: "Places & More" },
];
export function familyForKind(kind: InterestKind): string {
  return INTEREST_TYPES.find((item) => item.id === kind)?.family ?? "Places & More";
}
export function isSports(kind: InterestKind): boolean {
  return kind === "league" || kind === "team" || kind === "player";
}
export function isEntertainment(kind: InterestKind): boolean {
  return kind === "tv" || kind === "movie";
}
export function kindLabel(kind: InterestKind): string {
  return INTEREST_TYPES.find((item) => item.id === kind)?.label ?? "Interest";
}

export function defaultInterestPreferences(
  kind: InterestKind, title: string,
): InterestPreferences {
  return {
    keyword: title,
    timeRange: "day",
    dateFrom: "",
    dateTo: "",
    googleEnabled: true,
    providerEnabled: isEntertainment(kind) || isSports(kind),
    inheritWebsites: kind === "team" || kind === "player",
    websites: [],
    exclusions: "",
    artwork: isEntertainment(kind) ? ["Backdrops", "Posters"] :
      isSports(kind) ? ["Teams", "Players", "Game action"] : ["Landscapes"],
  };
}
export function preferencesFor(interest: FollowedInterest): InterestPreferences {
  const defaults = defaultInterestPreferences(interest.kind, interest.title);
  const raw = interest.preferences;
  if (!raw || typeof raw !== "object") return defaults;
  const timeRange = raw.timeRange;
  const windows: SearchWindow[] = ["day", "week", "month", "year", "any", "custom"];
  const sites = Array.isArray(raw.websites) ? raw.websites : [];
  const websites: InterestWebsite[] = [];
  for (const value of sites.slice(0, 10)) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry.host !== "string") continue;
    const host = normalizeLeagueWebsite(entry.host);
    if (!host || websites.some((site) => site.host === host)) continue;
    websites.push({ host, mode: entry.mode === "browser" ? "browser" : "google" });
  }
  return {
    keyword: typeof raw.keyword === "string" ? raw.keyword : defaults.keyword,
    timeRange: typeof timeRange === "string" && windows.includes(timeRange as SearchWindow)
      ? timeRange as SearchWindow : defaults.timeRange,
    dateFrom: typeof raw.dateFrom === "string" ? raw.dateFrom : "",
    dateTo: typeof raw.dateTo === "string" ? raw.dateTo : "",
    googleEnabled: typeof raw.googleEnabled === "boolean" ? raw.googleEnabled : true,
    providerEnabled: typeof raw.providerEnabled === "boolean"
      ? raw.providerEnabled : defaults.providerEnabled,
    inheritWebsites: typeof raw.inheritWebsites === "boolean"
      ? raw.inheritWebsites : defaults.inheritWebsites,
    websites,
    exclusions: typeof raw.exclusions === "string" ? raw.exclusions : "",
    artwork: Array.isArray(raw.artwork) ?
      raw.artwork.filter((value): value is string => typeof value === "string").slice(0, 10)
      : defaults.artwork,
  };
}

export function linkedWebsites(
  interest: FollowedInterest, all: FollowedInterest[],
): InterestWebsite[] {
  const result: InterestWebsite[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  function visit(current: FollowedInterest | undefined, depth: number) {
    if (!current || depth > 5 || visited.has(current.id)) return;
    visited.add(current.id);
    const prefs = preferencesFor(current);
    for (const site of prefs.websites) {
      if (seen.has(site.host)) continue;
      seen.add(site.host);
      result.push(site);
    }
    if (prefs.inheritWebsites && current.parentId) {
      visit(all.find((item) => item.id === current.parentId), depth + 1);
    }
  }
  visit(interest, 0);
  return result;
}

const TABS_KEY = "haven-walls.gallery-tab-labels.v1";
export type RenameableTab = "discover" | "sports" | "tmdb";
export const DEFAULT_TAB_LABELS: Record<RenameableTab, string> = {
  discover: "Discover", sports: "Sports Interests", tmdb: "TV & Movies",
};
export function readGalleryTabLabels(): Record<RenameableTab, string> {
  try {
    const json = JSON.parse(window.localStorage.getItem(TABS_KEY) || "{}");
    const result = { ...DEFAULT_TAB_LABELS };
    for (const tab of Object.keys(result) as RenameableTab[]) {
      const value = json?.[tab];
      if (typeof value === "string" && value.trim() && value.length <= 28 &&
          !/[<>\n\r]/.test(value)) result[tab] = value.trim();
    }
    return result;
  } catch { return { ...DEFAULT_TAB_LABELS }; }
}
export function writeGalleryTabLabels(labels: Record<RenameableTab, string>): void {
  window.localStorage.setItem(TABS_KEY, JSON.stringify(labels));
}

/** Move existing user-edited league website search profiles into SQLite once.
 * Never delete old localStorage content; preserve it for rollback and imports.
 * Names and search websites are adopted only if no corresponding interest exists.
 */
const MIGRATION_KEY = "haven-walls.personalization.sports-import.v1";
const DISCOVER_MIGRATION_KEY = "haven-walls.personalization.custom-discovery-import.v1";
export async function loadPersonalizationWithMigration() {
  let snapshot = await getPersonalization();
  if (window.localStorage.getItem(MIGRATION_KEY) !== "done") {
    for (const league of loadSportsLeagues()) {
      const providerId = "legacy-league-" + league.id;
      if (snapshot.followedInterests.some((item) =>
        item.kind === "league" &&
        (item.providerId === providerId ||
          item.title.toLowerCase() === league.name.toLowerCase())
      )) continue;
      const input: InterestInput = {
        kind: "league", provider: "custom", providerId,
        title: league.name, parentId: null,
        preferences: {
          ...defaultInterestPreferences("league", league.name),
          websites: league.websites.map((host) => ({ host, mode: "google" })),
        },
      };
      await saveFollowedInterest(input);
    }
    window.localStorage.setItem(MIGRATION_KEY, "done");
    snapshot = await getPersonalization();
  }
  // PR #4 custom discovery categories were search topics, not wallpaper tags.
  // Bring their saved prompts into the new discovery profile UI once.
  if (window.localStorage.getItem(DISCOVER_MIGRATION_KEY) !== "done") {
    let custom: unknown = [];
    try {
      custom = JSON.parse(window.localStorage.getItem(
        "haven-walls.discover.categories.v1") || "[]");
    } catch { /* Invalid old records are not imported. */ }
    if (Array.isArray(custom)) {
      for (const raw of custom.slice(0, 12)) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== "string" || !/^custom-[\w-]{1,60}$/.test(item.id) ||
          typeof item.name !== "string" || typeof item.prompt !== "string" ||
          !item.name.trim() || item.name.length > 60 ||
          item.prompt.length < 2 || item.prompt.length > 160) continue;
        const providerId = "legacy-discover-" + item.id;
        if (snapshot.followedInterests.some((saved) =>
          saved.providerId === providerId ||
          (saved.kind === "place" &&
            saved.title.toLowerCase() === item.name.toLowerCase())
        )) continue;
        await saveFollowedInterest({
          kind: "place", provider: "custom", providerId,
          title: item.name, parentId: null,
          preferences: {
            ...defaultInterestPreferences("place", item.name),
            keyword: item.prompt,
          },
        });
      }
    }
    window.localStorage.setItem(DISCOVER_MIGRATION_KEY, "done");
    snapshot = await getPersonalization();
  }
  return snapshot;
}
