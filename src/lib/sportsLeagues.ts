/** Locally saved, user-editable sports discovery profiles.
 * These are website SEARCH FILTERS, not permission to scrape or use images.
 * Credentials and API keys are deliberately never stored in this collection.
 */
export interface SportsLeague {
  id: string;
  name: string;
  websites: string[];
}

export const SPORTS_STORAGE_KEY = "haven-walls.sports-source-profiles.v1";
export const MAX_LEAGUES = 25;
export const MAX_WEBSITES = 10;
export const MAX_SPORTS_QUERY = 320;

export const DEFAULT_SPORTS_LEAGUES: SportsLeague[] = [
  { id: "nba", name: "NBA", websites: ["nba.com"] },
  { id: "ipl", name: "IPL", websites: ["iplt20.com"] },
];

/** Save host/path for Google's site: search operator. Never fetch URLs here. */
export function normalizeLeagueWebsite(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 220 || /\s/.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.protocol !== "https:" || url.username || url.password ||
      url.port || host === "localhost" || !host.includes(".") ||
      host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      host.startsWith("[") || !/^[a-z0-9.-]+$/.test(host) ||
      url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, "");
    if (path.includes("..") || path.length > 80 || /[^\w/.-]/.test(path)) return null;
    return host + path;
  } catch {
    return null;
  }
}

export function validLeagueName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 45 &&
    /^[\p{L}\p{N} .&+\-/()]+$/u.test(name) ? name : null;
}

export function loadSportsLeagues(): SportsLeague[] {
  try {
    const raw = window.localStorage.getItem(SPORTS_STORAGE_KEY);
    if (!raw) return DEFAULT_SPORTS_LEAGUES.map((item) => ({ ...item, websites: [...item.websites] }));
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("bad data");
    const ids = new Set<string>();
    const entries: SportsLeague[] = [];
    for (const value of parsed.slice(0, MAX_LEAGUES)) {
      if (value === null || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const name = typeof item.name === "string" ? validLeagueName(item.name) : null;
      if (!name || !Array.isArray(item.websites)) continue;
      const id = typeof item.id === "string" && /^[a-z0-9-]{1,64}$/.test(item.id)
        ? item.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (ids.has(id)) continue;
      ids.add(id);
      const sites: string[] = [];
      for (const site of item.websites.slice(0, MAX_WEBSITES)) {
        if (typeof site !== "string") continue;
        const normalized = normalizeLeagueWebsite(site);
        if (normalized && !sites.includes(normalized)) sites.push(normalized);
      }
      entries.push({ id, name, websites: sites });
    }
    return entries;
  } catch {
    return DEFAULT_SPORTS_LEAGUES.map((item) => ({ ...item, websites: [...item.websites] }));
  }
}

export function saveSportsLeagues(leagues: SportsLeague[]): boolean {
  try {
    window.localStorage.setItem(SPORTS_STORAGE_KEY, JSON.stringify(leagues));
    return true;
  } catch {
    return false;
  }
}

/** One Google Images query scoped to selected user-chosen sites.
 * The sites are never opened/scraped by the app itself.
 */
export function sportsWallpaperSearch(
  league: SportsLeague,
  subject: string,
  sites: string[],
): string | null {
  const name = subject.trim().slice(0, 100) || league.name;
  const topic = name.toLowerCase().includes(league.name.toLowerCase())
    ? name : name + " " + league.name;
  const base = topic + " 4K desktop wallpaper";
  const filters = sites.map(normalizeLeagueWebsite).filter((s): s is string => Boolean(s))
    .map((site) => "site:" + site);
  const suffix = filters.length === 0 ? "" :
    filters.length === 1 ? " " + filters[0] : " (" + filters.join(" OR ") + ")";
  const query = base + suffix;
  return query.length <= MAX_SPORTS_QUERY ? query : null;
}
