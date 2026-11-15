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
