mod sources;
mod local_storage;
mod app_settings;
mod personalization;
mod configuration;
mod wallpaper_library;
mod windows_wallpaper;
mod rotation;
mod rotation_discovery;
mod desktop_background;
#[cfg(windows)]
mod desktop_single_instance;
mod google_images;
mod category_discovery;
mod api_credentials;
mod google_browser;
mod internal_browser;
mod browser_storage;
mod browser_review;
#[cfg(windows)]
mod google_context_menu;
#[cfg(windows)]
mod browser_image_capture;
#[cfg(not(windows))]
mod browser_image_capture {
    #[tauri::command]
    pub fn browser_scan_images(_app: tauri::AppHandle, _tab_id: String)
        -> Result<(), String> {
        Err("Browser image scanning requires Windows WebView2.".into())
    }
}

use serde::Serialize;
use tauri::Manager;

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
    // Acquire before Tauri creates any windows, browser sessions or workers.
    // Launching Haven Walls again signals the existing window instead of
    // creating duplicate schedulers and background source requests.
    #[cfg(windows)]
    let _process_guard = match desktop_single_instance::acquire() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(problem) => {
            eprintln!("Haven Walls could not start safely: {problem}");
            return;
        }
    };

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
        .manage(rotation::RotationGate::default())
        .manage(wallpaper_library::best_source::InspectionCache::default())
        .manage(google_browser::PendingLensUpload::default())
        .setup(|app| {
            configuration::initialize(app.handle()).map_err(std::io::Error::other)?;
            desktop_background::setup(app)?;
            #[cfg(windows)]
            desktop_single_instance::watch_activation(app.handle().clone());
            rotation::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && desktop_background::keep_running_on_close(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
            internal_browser::browser_set_zoom,
            internal_browser::browser_tab_action,
            internal_browser::browser_tab_state,
            internal_browser::browser_close_tab,
            browser_image_capture::browser_scan_images,
            browser_storage::browser_load_data,
            browser_review::browser_load_review,
            browser_review::browser_save_review,
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
            personalization::get_personalization,
            personalization::create_personalization_group,
            personalization::rename_personalization_group,
            personalization::delete_personalization_group,
            personalization::save_wallpaper_organization,
            personalization::save_followed_interest,
            personalization::remove_followed_interest,
            wallpaper_library::open_wallpaper_source,
            windows_wallpaper::list_wallpaper_monitors,
            windows_wallpaper::get_wallpaper_activity,
            windows_wallpaper::get_active_wallpaper_preview,
            windows_wallpaper::apply_library_wallpaper,
            rotation::get_rotation_status,
            rotation::save_rotation_preferences,
            rotation::rotation_next,
            desktop_background::get_background_status,
            desktop_background::save_background_settings
        ])
        .run(tauri::generate_context!())
        .expect("Failed to launch Haven Walls");
}
