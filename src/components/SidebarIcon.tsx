/**
 * Small, dependency-free subset of Lucide's outline icon geometry for Haven
 * Walls' five navigation destinations.
 *
 * Icons: layout-dashboard, images, globe, folder-open, settings-2.
 * Source: https://lucide.dev/icons (Lucide, ISC license).
 * 24px viewBox with consistent 18px rendered size and 1.75px stroke.
 */
type SidebarIconName = "dashboard" | "gallery" | "browser" | "library" | "settings";

export default function SidebarIcon({ name }: { name: SidebarIconName }) {
  return (
    <svg
      className="nav-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === "dashboard" && (
        <>
          <rect width="7" height="9" x="3" y="3" rx="1" />
          <rect width="7" height="5" x="14" y="3" rx="1" />
          <rect width="7" height="9" x="14" y="12" rx="1" />
          <rect width="7" height="5" x="3" y="16" rx="1" />
        </>
      )}
      {name === "gallery" && (
        <>
          <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
          <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
          <circle cx="13" cy="7" r="1" fill="currentColor" />
          <rect x="8" y="2" width="14" height="14" rx="2" />
        </>
      )}
      {name === "browser" && (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </>
      )}
      {name === "library" && (
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      )}
      {name === "settings" && (
        <>
          <path d="M14 17H5" />
          <path d="M19 7h-9" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </>
      )}
    </svg>
  );
}
