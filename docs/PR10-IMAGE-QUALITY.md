# PR #10: Gallery image quality and broken-preview follow-up

The user verified the three-pass website search and combined Gallery results.
This follow-up improves *presentation and selection* of the results without
changing the existing WebView2 scanner, the providers, or Library imports.

## Behavior

- The saved-interest unified Gallery defaults to **Wallpaper candidates**.
  It hides obvious square/portrait images, tiny graphics and undersized
  previews when no distinct potential original image link is supplied.
- **All images** reveals small graphics and posters as well as landscapes.
  This matters for sports logos and TV/movie poster artwork.
- Search provider dimensions can describe the *thumbnail*. A small preview
  with a separate potential-original HTTPS image URL can remain visible; the
  presence of that URL does **not** prove the original is high resolution.
- The preview first attempts its supplied thumbnail URL. On failure, it tries
  up to four unique, safe alternative image URLs (original and provided
  candidates). Exhausted or unusably tiny previews are removed from the
  Gallery grid, not left as blank clickable cards.
- Card badges distinguish **Preview 299 × 168**, **Reported 1920 × 1080**
  and **Size unverified** rather than claiming an unverified wallpaper is 4K.
- The Gallery count and source filters update as images are filtered or
  broken previews are removed.
- FullResolutionPreview continues checking accessible originals and real
  pixel dimensions when a result is opened. Existing import/rights checks
  remain unchanged.

## Limitations

- Wallpaper-candidate filtering is conservative metadata-based triage, not
  full resolution verification, image content classification, or license
  verification. Remote images can be hotlink-protected, invalid or blocked.
- Image URLs are loaded lazily, so a broken preview is removed when the
  corresponding card is attempted, not necessarily when the search finishes.
- Loading every large original for dozens or hundreds of search results would
  be expensive; inspect individual images to verify the real original pixels.
- Results hidden by this filter are not deleted and can be accessed using
  **All images**. No wallpaper files are deleted or modified.

## Test on Windows

1. Pull the PR #10 branch, run `npm run build`, then launch Haven Walls.
2. Gallery → Sports Interests → Golden State Warriors → Find wallpapers.
   Check that square logos, tiny tiles and many low-resolution images
   disappear from the default **Wallpaper candidates** view.
3. Switch to **All images**. Confirm hidden results reappear.
4. Use source filters; verify the visible counts and tabs remain consistent.
5. Scroll through results. When thumbnails fail, verify alternatives load
   where possible and irrecoverable cards disappear instead of remaining blank.
6. Open a small-preview item with a larger original link. Confirm the existing
   full-resolution inspector verifies actual pixels; a reported search size
   must not be labeled verified without inspection.
7. Try sports logos, TV backdrops and portrait posters; confirm they remain
   accessible under All images.
8. Switch saved interests while results are loading. Old result thumbnails
   and rejected-preview state must not leak into the next search.
9. Confirm original Browser → Find Images, Review → Library, and wallpaper
   rotation are unchanged.

## Validation boundary

TypeScript syntax/type checks for the isolated quality helper and nine local
quality/filter/fallback scenarios were completed; the full Windows Tauri
build and live website image loading still need validation on the user's PC.
