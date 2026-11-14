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
    hint: "Browser Search needs no key. API Search uses the saved SerpApi key from Settings.",
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
    id: "discover",
    name: "Discover by Category",
    description: "Explore Nature, Earth, Space, Animals, Places and Sports with free photo catalogs.",
    hint: "Mix Wikimedia Commons, NASA and optional Google/Unsplash sources, then review and save.",
    action: "Discover wallpapers",
    defaultQuery: "",
    suggestions: [],
  },
  {
    id: "sports",
    name: "TheSportsDB",
    description: "Find team artwork and manage NBA, IPL, WNBA or custom league image websites.",
    hint: "Search a team, then add league websites and find wallpapers using Google Images site-filtered searches.",
    action: "Find teams",
    defaultQuery: "Golden State Warriors",
    suggestions: ["Golden State Warriors", "Los Angeles Lakers", "Mumbai Indians", "Chennai Super Kings"],
  },
  {
    id: "tmdb",
    name: "TMDB",
    description: "Find a TV show by its exact title, then browse available landscape backdrops.",
    hint: "Set your TMDB API Read Access Token once under Settings → API credentials.",
    action: "Find TV shows",
    defaultQuery: "Landman",
    suggestions: ["Landman", "Yellowstone", "The Lincoln Lawyer", "The Last of Us"],
    requiresToken: true,
  },
];

export function getCatalogSource(source: CatalogSourceId): SourceDefinition {
  return catalogSources.find((item) => item.id === source) ?? catalogSources[0];
}
