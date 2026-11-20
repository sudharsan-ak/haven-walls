# PR #10 — Commit 2: approved Gallery and Library redesign

This commit follows the accepted interactive prototype
`Haven-Walls-PR10-Synced-Interests-Custom-Tabs-Prototype.html`.

## Implemented

- Library has **Wallpapers**, **Categories**, **Collections** tabs.
- Categories is the canonical local SQLite editor for saved sports leagues,
  teams, players, TV shows, movies and places/topics.
- Sports website search preferences from the older Gallery panel and custom
  discovery topics are imported without deleting their old localStorage values.
- Categories support search keyword, Google date window, custom date bounds,
  source websites, Google site search vs manual Browser Find Images mode,
  parent website inheritance, exclusions and preferred artwork metadata.
- Team and TV-show creation optionally looks up stable provider IDs using the
  existing TheSportsDB and TMDB search commands.
- Gallery tabs are **Discover**, **Sports Interests**, **TV & Movies**,
  **Google Images**, **Bing Daily**. The first three display names can be
  customized locally without changing their fixed source identities.
- Gallery reads the *same* SQLite follows as Library. Sports includes leagues,
  teams and players; TV & Movies includes the corresponding saved interests;
  Discover includes all. Selecting a profile uses its keyword and sources.
- Source requests are user-triggered, and the native Google Images API now
  accepts a validated recent/custom date filter. Results from Google, site:
  queries and supported team/TV metadata are combined with image URL dedup.
- Over five searches require an explicit credit-use confirmation; more than
  sixty searches in one run are blocked. Individual failed providers are
  reported without discarding successful results.
- Gallery inspection uses the existing Full Resolution Preview; a review
  selection hands off to the existing Library import/rights checks.
- Browser-designated websites open in the existing WebView2 Browser for its
  manual **Find Images** scan. They are never crawled unattended.
- The former free photo category discovery view is still available through
  **Discover → Browse free photo categories**.
- Collections is now a dedicated view showing thumbnail groups and counts.
  Per-wallpaper collection assignment is retained. Legacy category/tag
  records remain in the database, but are not confused with search interests.
- Additive SQLite v2-to-v3 migration supports movie/place interests and
  preserves already saved follows, Library files, and groups.

## Not in this checkpoint

- Automatic scanning/crawling of arbitrary websites, or unattended downloads
  from third-party sports/TV sources. Search eligibility does not grant rights.
- Automated interest discovery and collection-based rotation.
- Exact movie provider matching, dynamic sports team/player rosters, weighting
  followed player results, or strict automated artwork type/spoiler filtering.
- Cross-session persistence of Gallery's temporary review selection (the
  existing Browser Review queue remains independent and persistent).

## Windows manual verification

1. `git fetch origin && git switch feature/pr10-personalized-interests-collections`
   then `git pull --ff-only`, `npm run build`, `npm run tauri dev`.
2. Open existing data: the Library and active wallpaper should be intact.
   Existing NBA/IPL league site preferences should become saved interests.
3. Library → Categories: create a League and Team, select the league as parent,
   add `nba.com` as Google site search and a Browser-mode website. Save,
   restart, verify persistence and inherited websites.
4. Create a TV show: when configured, select an exact TMDB show result.
   Verify Gallery → TV & Movies shows this saved show.
5. Gallery → Sports Interests: league/team/player dropdown should reflect
   Library immediately after switching pages. Discover shows all categories.
6. Gallery → Rename tabs: save a new title, navigate away and back, restart.
   Display text should persist, but filtering must still use the original type.
7. Configure Google Images past 24h and custom dates. With a SerpApi key,
   run searches; inspect source filters, combined images and partial errors.
   With no API key, expect a clear failure, not a fake successful search.
8. Open a Browser-mode website from an interest. In Browser click Find Images;
   the existing image scanner and review tools should still work.
9. Library → Collections: create, rename and delete a group; assign a wallpaper
   using its Collections action; click View wallpapers to see its filter.
   Deleting a collection must never remove wallpaper files.
10. Discover → Browse free photo categories should still load the original
    Nature, Space and other existing provider search UI.

## Validation boundary

No Windows/Rust/Tauri build was run from this connector environment.
The existing CI workflow is configured for *manual* invocation only.
Do not merge before a clean `npm run build`, `cargo test`, and on-device
Windows smoke test.
