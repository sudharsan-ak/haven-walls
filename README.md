# Haven Walls

Haven Walls is a **local-first wallpaper manager for Windows 11**. Discover, save, preview, and automatically rotate desktop wallpapers without an account or telemetry.

<img width="1902" height="1012" alt="image" src="https://github.com/user-attachments/assets/87941c97-34e5-4c80-a2b6-57cf3101924b" />

## Current features

- **Wallpaper discovery:** Browse Bing Daily, Wikimedia Commons, NASA, TheSportsDB, TMDB, Google Images, and optional Unsplash results. Some providers require your own API credentials.
- **Built-in browser:** Open websites in tabs, inspect images, save selections to a persistent Review queue, and import them into the Library. Includes bookmarks and browsing history.
- **Wallpaper Library:** Import local photos or online images, manage favorites, inspect image details, and check resolution and duplicates. Images and metadata are stored locally.
- **Windows desktop integration:** Preview the active wallpaper, apply images to all displays or a selected monitor, choose fit modes, and view recent wallpaper activity.
- **Automatic rotation:** Rotate saved images or eligible images from a protected offline reserve. Configure intervals or a daily time, no-repeat rules, Favorites-only mode, pause/pin, and selected discovery topics.
- **Background controls:** System tray actions, optional launch at Windows sign-in, and settings for image quality, sources, storage, and privacy.

Automatic online discovery currently uses a restricted Wikimedia Commons public-domain/CC0 workflow. Other sources support manual browsing and importing, subject to their terms and image rights.

<img width="1917" height="1016" alt="image" src="https://github.com/user-attachments/assets/46abdeca-4449-4147-aaff-2c3b1ead6490" />

## Coming next

Personalized sports and TV show follows, wallpaper collections, interest-aware discovery and rotation, plus more advanced scheduling, backup/restore, and lock-screen support (subject to Windows capability validation).

## Tech stack

**Tauri 2 · React · TypeScript · Vite · Rust · SQLite · WebView2**

Windows 11 is the primary development target; Windows 10 support is planned later.

## Development

Haven Walls is **under active development**, not yet a finished Windows release.

See [Windows build and test instructions](docs/WINDOWS-BUILD.md) to run the project locally. Changes are developed in feature branches and reviewed through pull requests.

> **Image rights:** Finding artwork or a photo online does not automatically grant permission to download or use it. Source terms, license restrictions, and attribution still apply.
