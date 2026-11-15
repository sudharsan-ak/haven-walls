mod sources;
mod local_storage;
mod app_settings;
mod configuration;
mod wallpaper_library;
mod windows_wallpaper;
mod google_images;
mod category_discovery;
mod api_credentials;
mod google_browser;
mod internal_browser;
mod browser_storage;
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
        // Preserve the opener service for trusted commands such as
        // "Open wallpaper source" while allowing native WebView2 new-tab
        // requests to reach each browser tab's on_new_window handler.
        // The default plugin script intercepts target=_blank and suppresses
        // the popup before WebView2 sees it on remote website pages.
        .plugin(tauri_plugin_opener::Builder::new()
            .open_js_links_on_click(false)
            .build())
        .manage(local_storage::StorageLock::default())
        .manage(google_browser::PendingLensUpload::default())
        .setup(|app| {
            configuration::initialize(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_host_info,
            sources::browse_wallpaper_source,
            sources::browse_tmdb_backdrops,
            google_images::browse_google_images,
            category_discovery::browse_category_images,
            api_credentials::get_api_credential_status,
            api_credentials::save_api_credential,
            api_credentials::remove_api_credential,
            internal_browser::browser_open_tab,
            internal_browser::browser_show_tab,
            internal_browser::browser_navigate_tab,
            internal_browser::browser_tab_action,
            internal_browser::browser_tab_state,
            internal_browser::browser_close_tab,
            browser_storage::browser_load_data,
            browser_storage::browser_save_session,
            browser_storage::browser_add_bookmark,
            browser_storage::browser_remove_bookmark,
            browser_storage::browser_clear_history,
            google_browser::open_google_images_inline,
            google_browser::open_google_lens_inline,
            google_browser::reverse_search_library_wallpaper_inline,
            google_browser::layout_google_images_inline,
            google_browser::set_google_images_inline_zoom,
            google_browser::close_google_images_inline,
            configuration::get_configuration,
            configuration::save_configuration,
            configuration::change_storage_mode,
            configuration::clear_temporary_cache,
            wallpaper_library::import_wallpaper_data,
            wallpaper_library::import_wallpaper_url,
            wallpaper_library::best_source::import_best_wallpaper_urls,
            wallpaper_library::best_source::inspect_best_wallpaper_urls,
            wallpaper_library::best_source::resolve_lens_publisher_preview,
            wallpaper_library::list_library_wallpapers,
            wallpaper_library::get_library_wallpaper_image,
            wallpaper_library::show_library_wallpaper_for_lens,
            wallpaper_library::set_wallpaper_favorite,
            wallpaper_library::remove_library_wallpaper,
            wallpaper_library::open_wallpaper_source,
            windows_wallpaper::list_wallpaper_monitors,
            windows_wallpaper::get_wallpaper_activity,
            windows_wallpaper::apply_library_wallpaper
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch Haven Walls");
}
