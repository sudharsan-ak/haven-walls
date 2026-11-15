# PR #5 · Built-in Browser

Status: **draft**, implementation underway. Approved visual reference:
\`Haven-Walls-PR5-Browser-Interactive-Prototype.html\`.

## Confirmed behavior

Dedicated Browser section in the sidebar. Multiple native browser tabs, URL and
Google search navigation, browser-style back/forward/reload/home, new-window
requests routed into new tabs, and normal links in the same tab. Google is the
new-tab homepage. Future commits will restore tabs between app launches,
preserve history/bookmarks/cookies, scan images and add right-click images to
the Inspect → Review → Library workflow. General downloads will go to
Windows Downloads.

## Commit 1: Browser foundation

- Add a **Browser** workspace without changing the Gallery's existing
  isolated Google Images WebView2, Google Lens and Library flows.
- Tauri child WebView2 surfaces with distinct native labels per tab.
  Visible tab fills the browser's native slot; inactive native webviews are
  hidden rather than destroyed. Opening background tabs is deferred.
- Browser controls: up to 12 tabs, +, close tab, address/search input, back,
  forward, reload and Google home. Tab titles, URLs and loading events are
  relayed to the trusted local shell.
- Website links use native navigation. Popup requests are denied inside the
  source webview and their validated HTTP(S) URLs open a separate native tab
  in the shell. Some OAuth/popup flows need further handling because opener
  relationships are not preserved.
- Navigation is restricted to HTTP(S); arbitrary file, JavaScript, data,
  internal Tauri and privileged schemes are rejected. Browser child webviews
  receive no Tauri capabilities or direct access to Haven Walls IPC commands.
- Switching to Library or Gallery hides browser WebViews while retaining
  their tabs in memory for this app session.
- Native child creation runs through async commands to avoid known Windows
  WebView2 deadlocks. React serializes display changes to prevent old async
  tabs from covering the selected tab.
- Bookmark, history, downloads, image scan, image Review and persistence UI
  are not live in Commit 1. They are reserved for Commits 2–4.

## Windows validation (Commit 1)

1. Run \`npm run build\` and \`npm run tauri dev\` on Windows 11.
2. Browser in sidebar: Google homepage loads as a real WebView2 page.
3. Type \`unsplash.com\` and Enter: navigates; a plain phrase runs a Google
   search. Try back, forward, reload and home.
4. Open 3 tabs with +, switch quickly, confirm only the active page is
   visible and each tab retains its page.
5. Test a target=_blank link: opens a new Haven Walls tab, not Edge.
6. Open Library, Settings, Gallery and return. Browser tabs remain.
   Google Images and Google Lens in Gallery still work independently.
7. Close tabs, including the final one (a fresh Google tab should appear).
8. Test a blocked address \`file:///C:/Windows\` or
   \`javascript:alert(1)\`, confirming navigation is rejected.
9. Resize/maximize window: WebView2 stays inside the browser slot and
   does not obscure tabs, toolbar, sidebar or window controls.

## Remaining planned commits

- **Commit 2:** Persistent session restore (lazy background tabs), isolated
  browser profile/cookies, history and bookmarks in local durable storage.
- **Commit 3:** Host-owned native right-click image capture and on-page image
  scanning with source-resolution validation.
- **Commit 4:** Inspect → Review → Library integration, general downloads,
  website permission prompts and browsing-data controls.

Do not merge into \`main\` until all four commits are tested and approved.

### Commit 1 Windows build fix

Tauri's `Webview` does not implement `can_go_back`, `can_go_forward`,
`go_back`, or `go_forward`. The browser uses Windows WebView2's
`ICoreWebView2::get_CanGoBack/get_CanGoForward/GoBack/GoForward` via
`with_webview`. The COM callbacks execute on the UI thread while an async
Tauri command awaits their result on a blocking worker to avoid UI deadlocks.

### Commit 1 follow-up: Google Images Visit / target=_blank links

The default Tauri opener plugin injects a click handler into native child
WebViews that intercepts target=_blank website links. Those remote pages do
not have Tauri opener IPC permissions, so Google Images **Visit** and ordinary
**Open link in new tab** actions can silently fail. Disable this automatic
interception using `tauri_plugin_opener::Builder::new()
.open_js_links_on_click(false).build()`, retaining the plugin for explicit
host-owned `app.opener().open_url()` calls. Our own native
`on_new_window` handler then relays the URL to a new internal browser tab.

Windows regression test: Click **Visit** on a Google Images photo, test a
standard target=_blank link and `Ctrl+Click`, then verify a new internal
tab opens the correct publisher URL and the ordinary Gallery and Library
source-link actions remain usable.


## Commit 2: persistent browsing (implementation)

- New SQLite tables browser_session, browser_history and browser_bookmarks.
  The schema is additive and safe to run repeatedly with existing data.
- Browser loads its saved session before creating any WebView2 website tab.
  Only the selected tab loads immediately; other tabs are lazy until selected.
  Tab titles, current URLs, order and active selection survive restarts.
- Bookmarks have user-editable titles and folder names; use ☆ to save a
  website, ☷ to open the bookmark manager, and ◷ to search recent history.
  Saved bookmarks can open in the current tab or a new internal tab.
- WebView2 uses the same app-owned browser-profile data directory for all
  internal tabs, with persistent cookies separate from Chrome/Edge profiles.
  This directory follows the existing Haven Walls storage root when migrated.
- The Rust host records finished navigations in SQLite, not via scripts
  injected into external pages. History is capped at 1500 visits. Clear
  History deletes only browser history, not bookmarks or API credentials.
- Session restoration does not promise scroll positions or form values.

Test on Windows: open three tabs, restart, and verify selected-tab-only lazy
loading; test bookmarks in custom folders, search history, clearing history,
cookie sign-in persistence, and Gallery/Library regression. Build both the
TypeScript frontend and native Rust release before accepting Commit 2.


## Commit 3: Find images and native right-click capture (Windows validation pending)

- Browser tabs install a native WebView2 context-menu item:
  **Add to Haven Walls review**, using the working Google Gallery
  context-menu code as the foundation. No Tauri permission is granted to
  remote pages. Native WebView2 returns the selected image URL, link URL,
  page URL and browser tab ID to the trusted Haven Walls shell.
- The enabled **Find images** button runs a *user-triggered, one-time*
  WebView2 ExecuteScript in the active page. No persistent script or
  automatic scraping is installed. Results include DOM img elements,
  srcset, data-original, Open Graph preview metadata, and inline CSS
  backgrounds. Cross-origin iframes and dynamic pages can expose only
  partial results.
- Rust filters images: HTTPS-only public hosts, bounded URL and title
  lengths, duplicate removal, maximum 160 results. A direct publisher
  webpage URL is not assumed to be an image.
- The scan gallery shows image previews, reported dimensions and
  original-image candidates. Inspect uses the existing full-resolution
  inspection flow, which verifies actual image size before saving.
- The Review tray collects up to 30 unique images across browser tabs.
  Users can inspect and remove selections. Actual Review to Library
  persistence stays disabled until Commit 4.
- The native WebView2 child is hidden for scan panels and inspection
  overlays so it does not paint over React controls.

### Windows acceptance for Commit 3

1. Build both the TypeScript frontend and Rust Windows Tauri application.
2. Visit Unsplash/Pexels and right-click a photo. Confirm the native
   **Add to Haven Walls review** option inserts it into Review.
3. Use **Find images** on a page with many photos. Confirm the thumbnail
   gallery appears with image candidates and reported dimensions.
4. Check several images, add them to Review, and inspect an original.
5. Repeat on Google Images. When only a publisher link is available,
   show a helpful limitation instead of adding webpage HTML as an image.
6. Switch tabs and rescan. Old results must not replace those from the
   currently active tab. Check a page with no detectable images.
7. Verify Review deduplicates candidates and never exceeds 30 images.
8. Close scan/inspection: the live webpage reappears, with navigation
   and controls still working and no native overlay leakage.
9. Verify existing Gallery Google Images/Lens and Library behavior remain
   unchanged. No Library import occurs from Browser during Commit 3.
10. Verify sessions, bookmarks, history and cookies still work after restart.

Important: the commit only proves code was pushed, not that the Windows
build passed. Test it locally before accepting Commit 3.


## Commit 3 UI refinement: side-by-side live website and Found / Review

Feedback from Windows testing showed the full-page image scan replacing the
website, and image rows collapsed into tiny strips. This is a repair to
Commit 3, **not** the start of Commit 4.

- The left side stays a live, independent native WebView2 browsing viewport.
  Scanning no longer hides or replaces it. The existing native ResizeObserver
  updates the WebView2 child as the viewport resizes.
- The right panel starts at 392px and can be resized by dragging its left
  divider; the divider is also keyboard-adjustable with ArrowLeft/ArrowRight.
  The panel has **Found** and **Review** tabs; Review is shared across URLs.
- Found uses a two-column grid with fixed 132px photo previews and
  max-content card rows so cards cannot collapse into image strips. It
  scrolls independently. Clicking the photo toggles selection. Search,
  size filter, select-results, original inspection and Add to Review remain.
- Found results are scoped to the tab and URL that was explicitly scanned.
  Navigating elsewhere shows an empty prompt until that page is scanned.
  Right-click capture switches to Review automatically; no images are
  imported or downloaded into Library in this refinement.
- Dedicated per-tab website zoom: minus, reset-percentage, plus (50%-200%).
  Native WebView2 zoom hotkeys are enabled. WebView2 zoom change events
  keep the toolbar percentage in sync with keyboard or mouse-wheel zoom.
  Zoom is saved with each tab in the existing SQLite browser session.
  Older saved sessions default to 100%; Rust rejects out-of-range zoom.
  Zoom affects only the website, never the React application shell.

### Windows retest after the layout refinement

1. Start Haven Walls on the updated PR #5 branch, build with npm and Rust,
   and verify the Browser still loads with restored tabs and bookmarks.
2. Visit a site with many images; click Find images. Keep the live webpage
   visible on the left while Found appears on the right.
3. Scroll the webpage and Found independently. The Found image cards should
   stay full-height and not collapse into thin horizontal strips.
4. Drag the dividing handle, including while the website is loading.
   The WebView2 viewport should resize without overlapping the right panel.
5. Click thumbnails (not just checkboxes), add them to Review, switch between
   Found / Review and back, and inspect a selected original.
6. Change website URL; Found must not show images from the previous page.
   Review images must remain unchanged. Switch browser tabs and confirm
   each tab retains only its own previously scanned URL results.
7. Zoom one tab to 120% and another to 80%, switch tabs, then restart
   Haven Walls. Zoom values and actual site display should restore per tab.
   Check Ctrl + plus/minus/zero while the website has focus.
8. Confirm native right-click capture, existing Google Gallery / Lens,
   bookmarks, history, and Library are unaffected. Import to Library
   remains a Commit 4 task.

This update is **not Windows build verified** until run on Windows.
