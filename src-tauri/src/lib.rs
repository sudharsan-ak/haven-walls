mod commons;

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
        .invoke_handler(tauri::generate_handler![get_host_info, commons::search_commons_wallpapers])
        .run(tauri::generate_context!())
        .expect("Failed to launch Haven Walls");
}
