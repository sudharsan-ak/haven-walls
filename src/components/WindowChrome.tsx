import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type MouseEvent } from "react";
import "./WindowChrome.css";

const nativeWindow = isTauri() ? getCurrentWindow() : null;

const resizeEdges = [
  { name: "north", direction: "North" },
  { name: "south", direction: "South" },
  { name: "east", direction: "East" },
  { name: "west", direction: "West" },
  { name: "north-east", direction: "NorthEast" },
  { name: "north-west", direction: "NorthWest" },
  { name: "south-east", direction: "SouthEast" },
  { name: "south-west", direction: "SouthWest" },
] as const;

export default function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeWindow) return;

    let active = true;
    let stopListening: (() => void) | undefined;

    const updateMaximized = async () => {
      try {
        const value = await nativeWindow.isMaximized();
        if (active) setMaximized(value);
      } catch (error) {
        if (active) setWindowError(String(error));
      }
    };

    void updateMaximized();
    void nativeWindow
      .onResized(() => void updateMaximized())
      .then((unlisten) => {
        if (active) stopListening = unlisten;
        else unlisten();
      })
      .catch((error: unknown) => {
        if (active) setWindowError(String(error));
      });

    return () => {
      active = false;
      stopListening?.();
    };
  }, []);

  const runWindowAction = async (action: "minimize" | "maximize" | "close") => {
    if (!nativeWindow) return;
    try {
      if (action === "minimize") await nativeWindow.minimize();
      else if (action === "maximize") {
        await nativeWindow.toggleMaximize();
        setMaximized(await nativeWindow.isMaximized());
      } else await nativeWindow.close();
      setWindowError(null);
    } catch (error) {
      setWindowError(String(error));
    }
  };

  const beginResize = (direction: (typeof resizeEdges)[number]["direction"], event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !nativeWindow) return;
    void nativeWindow.startResizeDragging(direction).catch((error: unknown) => {
      setWindowError(String(error));
    });
  };

  return (
    <>
      <header className="topbar">
        <div className="titlebar-drag-area" data-tauri-drag-region>
          <div className="identity" data-tauri-drag-region>
            <span className="brand-mark" aria-hidden="true" data-tauri-drag-region>H</span>
            <span data-tauri-drag-region>Haven Walls</span>
          </div>
          <span className="app-version" data-tauri-drag-region>
            {windowError ? "Window control error" : "Foundation · v0.1.0"}
          </span>
        </div>
        <div className="window-actions" aria-label="Window controls">
          <button
            className="window-control"
            type="button"
            aria-label="Minimize"
            title="Minimize"
            disabled={!nativeWindow}
            onClick={() => void runWindowAction("minimize")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12H19" /></svg>
          </button>
          <button
            className="window-control"
            type="button"
            aria-label={maximized ? "Restore window" : "Maximize"}
            title={maximized ? "Restore window" : "Maximize"}
            disabled={!nativeWindow}
            onClick={() => void runWindowAction("maximize")}
          >
            {maximized ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 6H18V16H16M6 9H15V18H6Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="0.5" /></svg>
            )}
          </button>
          <button
            className="window-control close-control"
            type="button"
            aria-label="Close"
            title="Close Haven Walls"
            disabled={!nativeWindow}
            onClick={() => void runWindowAction("close")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" /></svg>
          </button>
        </div>
      </header>
      {windowError && <div className="window-error" role="alert">Window control failed: {windowError}</div>}
      {nativeWindow && !maximized && (
        <div className="window-resize-regions" aria-hidden="true">
          {resizeEdges.map((edge) => (
            <div
              key={edge.name}
              className={"resize-handle resize-handle-" + edge.name}
              onMouseDown={(event) => beginResize(edge.direction, event)}
            />
          ))}
        </div>
      )}
    </>
  );
}
