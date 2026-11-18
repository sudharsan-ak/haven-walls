//! Explicit, user-triggered Gallery image discovery. A dedicated hidden
//! WebView2 loads one requested search page and runs the same bounded DOM
//! image scanner as Browser -> Find Images. No third-party site receives Tauri
//! capabilities and no images are downloaded by this command.
#![cfg(windows)]

use std::{
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    time::Duration,
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use crate::{browser_image_capture, local_storage};

const PREFIX: &str = "hw-interest-search-";
pub const RESULT_EVENT: &str = "haven-interest-search-results";
pub const ERROR_EVENT: &str = "haven-interest-search-error";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryError {
    tab_id: String,
    message: String,
}

fn label(search_id: &str) -> Result<String, String> {
    if !(1..=48).contains(&search_id.len()) ||
        !search_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err("Invalid discovery request identifier.".into());
    }
    Ok(format!("{PREFIX}{search_id}"))
}

fn allowed(url: &tauri::Url) -> bool {
    browser_image_capture::validated_web_url(url.as_str()).is_some()
}

fn report_error(app: &AppHandle, tab_id: &str, message: impl Into<String>) {
    let _ = app.emit_to("main", ERROR_EVENT, DiscoveryError {
        tab_id: tab_id.to_string(), message: message.into(),
    });
}

/// Native COM callback: validates the remote result using Browser's existing
/// parsing and safety limits, then emits only image metadata to the shell.
fn inspect_loaded_page(
    app: AppHandle, webview: tauri::Webview, search_id: String,
) -> Result<(), String> {
    let failure_app = app.clone();
    let failure_id = search_id.clone();
    webview.with_webview(move |platform| {
        let dispatched = (|| -> windows::core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            let result_app = app.clone();
            let id = search_id.clone();
            let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(
                move |result, json| {
                    match result {
                        Ok(()) => match browser_image_capture::parse_scan(&json, id.clone()) {
                            Ok(images) => { let _ = result_app.emit_to("main", RESULT_EVENT, images); }
                            Err(err) => report_error(&result_app, &id, err),
                        },
                        Err(_) => report_error(
                            &result_app, &id, "WebView2 could not inspect the loaded search page.",
                        ),
                    }
                    Ok(())
                },
            ));
            let script: Vec<u16> = browser_image_capture::SCAN_JS
                .encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                core.ExecuteScript(windows::core::PCWSTR(script.as_ptr()), &handler)?;
            }
            Ok(())
        })();
        if let Err(err) = dispatched {
            report_error(&failure_app, &failure_id,
                format!("Could not start the webpage image scan: {err}"));
        }
    }).map_err(|_| "Could not access the hidden search webview.".to_string())
}

/// A single page per command. The UI runs queries sequentially, waits for
/// results and always closes this private view before starting another.
/// Must be async: creating WebView2 from a synchronous command can deadlock.
#[tauri::command]
pub async fn start_interest_page_search(
    app: AppHandle, search_id: String, url: String,
) -> Result<(), String> {
    let webview_label = label(&search_id)?;
    if app.get_webview(&webview_label).is_some() {
        return Err("This image search is already running.".into());
    }
    if app.webviews().keys().filter(|name| name.starts_with(PREFIX)).count() >= 2 {
        return Err("A previous image search is still closing. Retry shortly.".into());
    }
    let parsed = tauri::Url::parse(&url)
        .map_err(|_| "Invalid image search URL.".to_string())?;
    if !allowed(&parsed) || url.len() > 4096 {
        return Err("Only public HTTPS search websites are supported.".into());
    }
    let parent = app.get_window("main")
        .ok_or_else(|| "Haven Walls main window is unavailable.".to_string())?;
    let paths = local_storage::current_paths(&app)?;
    let profile = paths.root.join("interest-discovery-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|_| "Could not prepare local discovery browser storage.".to_string())?;

    let load_app = app.clone();
    let id_for_load = search_id.clone();
    let started = Arc::new(AtomicBool::new(false));
    let started_for_load = started.clone();
    let builder = WebviewBuilder::new(webview_label.clone(), WebviewUrl::External(parsed))
        .data_directory(profile)
        .on_navigation(allowed)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(move |view, event| {
            if !matches!(event.event(), PageLoadEvent::Finished) ||
                !allowed(event.url()) ||
                started_for_load.swap(true, Ordering::AcqRel) {
                return;
            }
            let runner_app = load_app.clone();
            let runner_id = id_for_load.clone();
            let runner_label = format!("{PREFIX}{runner_id}");
            // Let lazy image attributes settle, without blocking WebView2's
            // UI thread. Some remote sites may still load only placeholders.
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(1400));
                if let Some(active_view) = runner_app.get_webview(&runner_label) {
                    if let Err(message) = inspect_loaded_page(
                        runner_app.clone(), active_view, runner_id.clone()
                    ) {
                        report_error(&runner_app, &runner_id, message);
                    }
                }
            });
            let _ = view; // No user-facing navigation or view interaction.
        });
    let child = parent.add_child(
        builder, LogicalPosition::new(-12000.0, -12000.0), LogicalSize::new(1100.0, 700.0),
    ).map_err(|_| "Could not create the isolated discovery webview.".to_string())?;
    // Keep the user on the Gallery screen. This view is for on-demand
    // metadata extraction only and must never be added to the Browser tabs.
    if let Err(error) = child.hide() {
        let _ = child.close();
        return Err(format!("Could not hide the discovery webview: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn close_interest_page_search(
    app: AppHandle, search_id: String,
) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label(&search_id)?) {
        view.close().map_err(|_| "Could not close the discovery webview.".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_search_urls_only() {
        assert!(allowed(&"https://www.google.com/search?q=dogs".parse().unwrap()));
        assert!(allowed(&"https://www.nba.com/".parse().unwrap()));
        assert!(!allowed(&"http://example.com".parse().unwrap()));
        assert!(!allowed(&"https://127.0.0.1".parse().unwrap()));
        assert!(!allowed(&"https://localhost/".parse().unwrap()));
        assert!(label("run-123-0").is_ok());
        assert!(label("../browser").is_err());
    }
}
