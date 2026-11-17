# PR #8: UI polish and first-use guidance

This PR implements five targeted user-approved UI refinements **without** a
global typography change or changes to the Rust wallpaper/rotation engine.

## Scope

1. **Dashboard presentation.** Keep the full photo visible instead of repeating
   its title as a large image overlay. The actual title is shown in the detail
   panel, truncated visually only when unusually long, with the complete title
   available as a tooltip. Current-wallpaper verification and live previews
   continue to come from Windows.
2. **Library cards.** The full card opens Inspect. A single visible Set Now
   action and persistent Favorite heart replace the crowded action row. The
   overflow menu contains Inspect Details and a protected Remove action.
   Removal still requires the existing confirmation dialog and refuses
   current/assigned wallpapers, even when triggered from the card menu.
3. **Settings feedback.** Five Settings tabs remain unchanged and stay visible
   while scrolling. A clearer inline status explains unsaved changes, save
   failures and successful saves, with a Save Changes button when appropriate.
   The existing sticky bottom Save/Discard actions and persistence commands are
   unchanged. No new settings storage.
4. **Automation status.** Show an accessible offline-reserve progress bar
   (0–10), a concise status label, last-attempt topic/outcome and next check.
   Present provider cooldowns in plain language; raw provider errors and
   source licensing policy remain available in expandable technical details.
   No new network requests or backend retry logic.
5. **Empty states.** Dashboard has Browse Gallery / Open Library actions when
   no current Haven Walls wallpaper is confirmed. A missing rotation pool
   suggests Library or Gallery, with a Favorites-only explanation when
   relevant. The Library distinguishes empty collections from filters that
   return no matches, with working Import, Gallery and Clear Filters actions.

## Source and safety boundaries

- No changes to font sizes or global typography.
- No changes to image bytes, downloads, rights handling, duplicate rules,
  Windows apply, rotation schedule, discovery rate limits or persistence.
- Browser, Gallery, Settings > Sources and protected offline-reserve workflows
  remain untouched.
- PR #8 is stacked on PR #7 while #7 is open. **Do not merge PR #8 into
  main independently of PR #7.** After #7 merges, retarget or update PR #8
  against main as appropriate.

## Windows verification checklist

1. Pull the PR #8 feature branch, run `npm run build` and `npm run tauri dev`.
2. Dashboard: photo is unobstructed, full title readable in the details
   panel/tooltip, expand still works, Next still reflects the new wallpaper.
3. Library: click photo, title, and blank card area to Inspect. Test
   Set Now, Favorite heart, menu open/close, Escape and outside-click close.
4. Try removing a noncurrent wallpaper through the menu: the existing
   confirmation must appear and Remove/Cancel must behave correctly.
   Verify a current/assigned wallpaper cannot be removed from the menu.
5. Settings: edit a normal preference, change tabs, use the visible Save
   button, confirm persistence after a restart. Discard still works.
   Verify the five-tab bar stays visible on a long tab while scrolling.
6. Automation: reserve progress agrees with backend count. Check off,
   empty, saved, no-match, 429/503 cooldown and general-error labels,
   and expand Technical Details to access the original provider response.
7. Empty Library: Browse Gallery and Import from computer both work.
   Filter to zero results: Clear Filters restores the grid without
   losing saved files or favorites.
8. No current Haven Walls wallpaper: Dashboard offers actions and doesn't
   falsely claim an external Windows wallpaper is managed. A zero-eligible
   rotation pool shows appropriate guidance.
9. Confirm Browse/Library/Settings/Browser, Favorites-only, tray actions,
   Windows startup, saved settings and preview cache still work.
10. Narrow the Haven Walls window to verify the Library menu and Settings
    sticky tab bar remain usable.

Source checks were performed before publishing this commit, but final
TypeScript and Windows/Tauri runtime verification must happen locally.
