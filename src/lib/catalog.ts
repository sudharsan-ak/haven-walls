import type { CatalogSourceId } from "./native";

export interface SourceDefinition {
  id: CatalogSourceId;
  name: string;
  description: string;
  hint: string;
  action: string;
  defaultQuery: string;
  suggestions: string[];
  requiresToken?: boolean;
}

export const catalogSources: SourceDefinition[] = [
  {
    id: "bing",
    name: "Bing Daily",
    description: "Recent featured photography from Bing's homepage image feed.",
    hint: "Bing supplies recent daily photos, not keyword searches.",
    action: "Load recent photos",
    defaultQuery: "",
    suggestions: [],
  },
  {
    id: "google",
    name: "Google Images",
    description: "Two modes: an embedded Google Images browser or filtered SerpApi results.",
    hint: "Browser Search needs no API key. API Search provides structured results and quality filters.",
    action: "Search Google Images",
    defaultQuery: "Golden State Warriors 4K desktop wallpaper",
    suggestions: [
      "Golden State Warriors 4K desktop wallpaper",
      "Landman TV series 4K wallpaper",
      "Switzerland Alps landscape wallpaper",
      "Mumbai Indians IPL 4K wallpaper",
    ],
    requiresToken: true,
  },
  {
    id: "earth",
    name: "Google Earth View",
    description: "Explore aerial landscapes from a community archive of Earth View imagery.",
    hint: "Leave the location blank for a varied selection, or filter by country or region.",
    action: "Browse Earth View",
    defaultQuery: "",
    suggestions: ["Switzerland", "United States", "India", "Iceland"],
  },
  {
    id: "sports",
    name: "TheSportsDB",
    description: "Search teams and their associated images from sports such as NBA and IPL.",
    hint: "Search a team name. Team badges and artwork may not be wallpaper-sized.",
    action: "Find teams",
    defaultQuery: "Golden State Warriors",
    suggestions: ["Golden State Warriors", "Los Angeles Lakers", "Mumbai Indians", "Chennai Super Kings"],
  },
  {
    id: "tmdb",
    name: "TMDB",
    description: "Find a TV show by its exact title, then browse available landscape backdrops.",
    hint: "TMDB requires your own API Read Access Token. It is kept in memory only for this session.",
    action: "Find TV shows",
    defaultQuery: "Landman",
    suggestions: ["Landman", "Yellowstone", "The Lincoln Lawyer", "The Last of Us"],
    requiresToken: true,
  },
];

export function getCatalogSource(source: CatalogSourceId): SourceDefinition {
  return catalogSources.find((item) => item.id === source) ?? catalogSources[0];
}
