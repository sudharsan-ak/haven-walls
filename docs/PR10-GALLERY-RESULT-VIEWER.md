# PR #10 follow-up: Gallery result viewer with navigation

## Purpose

The saved-wallpaper Library already has a large image viewer with previous/next
arrows, a horizontal thumbnail filmstrip, image counters and keyboard browsing.
Gallery's discovered-image modal previously opened one image at a time, forcing
users to close the modal and return to the grid after each preview.

## Implementation

- Reuse the existing `FullResolutionPreview` inspector, preserving original
  resolution verification, remote URL inspection, source links and the existing
  Review → Save handoff.
- Add **optional** Gallery navigation to the inspector; other screens using the
  standalone inspector keep their original behavior.
- When opened from saved-interest Gallery results, show the current image in
  an image-first, two-column layout with details on the right.
- Previous and next arrows, Left/Right keys, thumbnail clicks and a horizontally
  scrollable filmstrip navigate the **currently visible result set**.
- The result set respects active source and image-quality filters. Filtering or
  hiding an item never deletes the original discovery record.
- Image position and total are displayed as `3 / 8`; the selected thumbnail is
  highlighted and automatically scrolled into view.
- Fit/Fill options affect viewer display only. They never resize an original.
- Escape/Close closes the viewer; disabled arrows indicate fewer than two
  navigable results.
- When navigating to another result, existing image-resolution inspection
  state is reset and prior pending async lookups are safely ignored by the
  current component's abort/cleanup behavior.

## Windows validation

1. Pull PR #10 and run `npm run build` before a full Windows build.
2. Gallery → Sports Interests → Golden State Warriors → Find Wallpapers.
   Click any candidate. Confirm the viewer is large and remains open while
   browsing results.
3. Test on-screen arrows, Left/Right keyboard, thumbnail clicks, Escape and
   the counter. Verify wrapping at the first/last result and selected thumbnail
   auto-scroll when many results are present.
4. Switch to All images or filter by source, then inspect. The filmstrip should
   contain **only** results currently visible in the grid.
5. Confirm Fit and Fill only change image presentation, not actual dimensions.
6. Verify original image resolution checking and Add to Review work after
   navigating to several different images.
7. Check single-result searches: arrows should be disabled.
8. Verify the old standalone Google Images / TMDB preview still opens normally,
   with no unexpected filmstrip or layout changes.
9. Test on a smaller window: image stage and details stack vertically while
   thumbnails remain horizontally scrollable.

## Validation boundary

This connector session can review source and push commits, but cannot run the
Windows WebView2 app. A full local frontend build and Windows smoke test are
required before merging PR #10.
