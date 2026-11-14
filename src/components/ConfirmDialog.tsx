import { useEffect, useId } from "react";
import "./ConfirmDialog.css";

interface Props {
  title: string;
  description: string;
  note?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "warning" | "standard";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app confirmation used instead of WebView2's native default prompt. */
export default function ConfirmDialog({
  title, description, note, confirmLabel, cancelLabel = "Cancel",
  tone = "standard", busy = false, onConfirm, onCancel,
}: Props) {
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy) onCancel();
      }
    }
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => window.removeEventListener("keydown", handleKey, { capture: true });
  }, [busy, onCancel]);

  return (
    <div className="hwc-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="hwc-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={descriptionId}>
        <div className={"hwc-symbol hwc-symbol-" + tone} aria-hidden="true">
          {tone === "danger" ? "!" : tone === "warning" ? "?" : "i"}
        </div>
        <div className="hwc-content">
          <span className="hwc-eyebrow">Haven Walls · Confirmation</span>
          <h2 id={headingId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {note && <div className="hwc-note">{note}</div>}
        </div>
        <div className="hwc-actions">
          <button type="button" className="hwc-cancel" disabled={busy}
            onClick={onCancel} autoFocus>{cancelLabel}</button>
          <button type="button"
            className={"hwc-confirm hwc-confirm-" + tone}
            disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
