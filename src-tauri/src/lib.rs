mod sources;
mod google_images;
mod google_browser;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    app_name: &'static str,
    version: &'static str,
    platform: &'static str,
}

// A tiny native command proves React ↔ Rust communication before feature work.
#[tauri::command]
fn get_host_info() -> HostInfo {
    HostInfo {
        app_name: "Haven Walls",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_host_info,
            sources::browse_wallpaper_source,
            sources::browse_tmdb_backdrops,
            google_images::browse_google_images,
            google_browser::open_google_images_inline,
            google_browser::layout_google_images_inline,
            google_browser::set_google_images_inline_zoom,
            google_browser::close_google_images_inline
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch Haven Walls");
}
