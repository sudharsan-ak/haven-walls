mod sources;
mod local_storage;
mod app_settings;
mod configuration;
mod wallpaper_library;
mod google_images;
mod google_browser;
#[cfg(windows)]
mod google_context_menu;

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
        .manage(local_storage::StorageLock::default())
        .setup(|app| {
            configuration::initialize(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_host_info,
            sources::browse_wallpaper_source,
            sources::browse_tmdb_backdrops,
            google_images::browse_google_images,
            google_browser::open_google_images_inline,
            google_browser::layout_google_images_inline,
            google_browser::set_google_images_inline_zoom,
            google_browser::close_google_images_inline,
            configuration::get_configuration,
            configuration::save_configuration,
            configuration::change_storage_mode,
            configuration::clear_temporary_cache,
            wallpaper_library::import_wallpaper_data,
            wallpaper_library::import_wallpaper_url,
            wallpaper_library::list_library_wallpapers,
            wallpaper_library::get_library_wallpaper_image,
            wallpaper_library::set_wallpaper_favorite,
            wallpaper_library::remove_library_wallpaper
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch Haven Walls");
}
