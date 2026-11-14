import { useEffect, useRef, useState } from "react";
import {
  closeGoogleImagesInline,
  layoutGoogleImagesInline,
  openGoogleImagesInline,
  setGoogleImagesInlineZoom,
  type GoogleInlineBounds,
} from "../lib/native";

interface Props {
  query: string;
  searchRevision: number;
  obscured: boolean;
  zoom: number;
  viewportHeight: number;
  onError: (message: string) => void;
}

/** The actual Google page is a native child WebView2, NOT an iframe or fake results.
 * Cross-origin content never becomes DOM data available to this React component.
 */
export default function InlineGoogleBrowser({
  query, searchRevision, obscured, zoom, viewportHeight, onError,
}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const hasView = useRef(false);
  const disposing = useRef(false);
  const obscuredRef = useRef(obscured);
  const zoomRef = useRef(zoom);
  const frame = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  function measure(): GoogleInlineBounds | null {
    const slot = slotRef.current;
    const content = slot?.closest(".content");
    if (!slot || !content) return null;

    const box = slot.getBoundingClientRect();
    const viewport = content.getBoundingClientRect();
    const x = Math.max(0, box.left, viewport.left);
    const y = Math.max(0, box.top, viewport.top);
    const right = Math.min(window.innerWidth, box.right, viewport.right);
    const bottom = Math.min(window.innerHeight, box.bottom, viewport.bottom);
    const width = Math.floor(right - x);
    const height = Math.floor(bottom - y);
    return width >= 100 && height >= 90
      ? { x: Math.round(x), y: Math.round(y), width, height }
      : null;
  }

  function syncLayout() {
    if (!hasView.current) return;
    const bounds = obscuredRef.current || disposing.current ? null : measure();
    void layoutGoogleImagesInline(bounds).catch(() => {
      // A layout race during tab changes must not affect the main app.
    });
  }

  function scheduleLayout() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      syncLayout();
    });
  }

  // The native child must follow the scrolling content panel and window resize.
  useEffect(() => {
    disposing.current = false;
    const onLayout = () => scheduleLayout();
    const content = slotRef.current?.closest(".content");
    const observer = new ResizeObserver(onLayout);
    if (slotRef.current) observer.observe(slotRef.current);
    if (content) observer.observe(content);
    window.addEventListener("resize", onLayout);
    document.addEventListener("scroll", onLayout, true);

    return () => {
      disposing.current = true;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      observer.disconnect();
      window.removeEventListener("resize", onLayout);
      document.removeEventListener("scroll", onLayout, true);
      // Do not leave Google's webview floating over other Haven Walls pages.
      hasView.current = false;
      void closeGoogleImagesInline().catch(() => {});
    };
  }, []);

  useEffect(() => {
    obscuredRef.current = obscured;
    scheduleLayout();
  }, [obscured]);

  useEffect(() => {
    zoomRef.current = zoom;
    if (hasView.current) {
      void setGoogleImagesInlineZoom(zoom).catch(() =>
        onError("The Google Images zoom could not be changed.")
      );
    }
  }, [zoom]);

  useEffect(() => {
    if (searchRevision === 0) return;
    let canceled = false;
    let pendingFrame = 0;
    const start = async () => {
      const slot = slotRef.current;
      slot?.scrollIntoView({ behavior: "auto", block: "nearest" });
      // Wait for the scrolling container to calculate the native slot position.
      pendingFrame = requestAnimationFrame(async () => {
        if (canceled || disposing.current) return;
        const bounds = measure();
        if (!bounds) {
          onError("Scroll the embedded browser area into view, then search again.");
          return;
        }
        try {
          await openGoogleImagesInline(query, bounds);
          if (canceled || disposing.current) {
            await closeGoogleImagesInline().catch(() => {});
            return;
          }
          hasView.current = true;
          setLoaded(true);
          await setGoogleImagesInlineZoom(zoomRef.current);
          scheduleLayout();
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
      });
    };
    void start();
    return () => {
      canceled = true;
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
    };
  // Only an explicit search changes searchRevision; typing must not navigate.
  }, [searchRevision]);

  return (
    <div className="gws-browser-viewport" style={{ height: viewportHeight }}>
      <div className="gws-browser-placeholder" aria-hidden="true">
        <span className="gws-browser-placeholder-icon">◎</span>
        <strong>{loaded ? "Google Images" : "Your embedded Google Images browser"}</strong>
        <p>
          {loaded
            ? "The native Google page loads in this area."
            : "Enter a search above and select Search Google Images to start browsing."}
        </p>
      </div>
      <div ref={slotRef} className="gws-native-slot"
        aria-label="Embedded Google Images browser content" />
    </div>
  );
}
