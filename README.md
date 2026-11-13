# Haven Walls

Haven Walls is a **local-first wallpaper manager for Windows** that helps you discover, preview, organize, and rotate high-quality desktop wallpapers.

The first development priority is **online wallpaper discovery**. Importing wallpapers from local files and folders will come later.

## Planned features

- Discover wallpapers from supported, permitted online sources.
- Preview images and apply them to the Windows desktop.
- Follow interests such as sports leagues, teams, players, TV shows, and custom topics.
- Organize favorites, categories, history, and a review queue.
- Rotate wallpapers automatically, including per-monitor preferences.
- Manage cached images, offline availability, and backups.
- Run quietly in the system tray, without accounts or telemetry.

## Tech stack

- **Desktop:** Tauri 2
- **Frontend:** React, TypeScript, Vite
- **Native/background core:** Rust
- **Local data:** SQLite
- **Initial target:** Windows 11 (Windows 10 support later)

## Development status

**Planning / repository initialization.** The application has not been implemented yet.

### First milestone: Online Wallpaper MVP

1. Set up the Tauri, React, TypeScript, and Rust application.
2. Integrate a suitable online wallpaper source and display real results.
3. Validate, download, and apply an image using Windows native APIs.
4. Add a basic gallery, active-wallpaper status, and persistence.

Local image import, personalized discovery, rotation, and advanced features will follow in later milestones.

## Development workflow

Changes will be made on feature branches and reviewed through GitHub pull requests. Windows behavior will be tested locally before merging.

> **Image rights matter:** Finding an image or its metadata online does not automatically grant permission to download, cache, or use it. Each provider integration must be validated against its terms and applicable image licenses.
