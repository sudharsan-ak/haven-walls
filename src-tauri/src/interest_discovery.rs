//! On-demand Gallery discovery using an isolated off-screen WebView2.
//! The original Browser's bounded image parser is reused without exposing
//! native APIs to remote web content or downloading remote files.
#![cfg(windows)]

use std::{
    sync::{Arc, atomic::{AtomicBool, Ordering}},
    time::Duration,
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use webview2_com::ExecuteScriptCompletedHandler;
use windows::core::PCWSTR;
use crate::{browser_image_capture, local_storage};

const PREFIX: &str = "hw-interest-search-";
pub const RESULT_EVENT: &str = "haven-interest-search-results";
pub const ERROR_EVENT: &str = "haven-interest-search-error";

// A site-native search is attempted only when its actual page exposes a
// suitable search input/form. No invented /search?q= endpoint is assumed.
// Only GET forms on the current HTTPS origin are submitted automatically.
// SPA inputs receive ordinary input/change/Enter events as a best effort.
const NATIVE_SEARCH_SCRIPT: &str = r#"
(() => {
  const term = __SEARCH_TERM__;
  const fields = Array.from(document.querySelectorAll(
    'input[type="search"], form[role="search"] input, input[name="q"], input[name="query"], input[name="search"], input[placeholder*="Search"], input[placeholder*="search"]'
  ));
  const input = fields.find(node => node instanceof HTMLInputElement &&
    !node.disabled && !node.readOnly && node.type !== 'hidden');
  if (!input) return 'unavailable';
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype, 'value'
  )?.set;
  if (setter) setter.call(input, term);
  else input.value = term;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const form = input.form || input.closest('form');
  if (form) {
    const action = new URL(form.getAttribute('action') || location.href, location.href);
    if (action.protocol !== 'https:' || action.hostname !== location.hostname ||
        form.method.toLowerCase() !== 'get') return 'unavailable';
    if (input.name) {
      action.searchParams.set(input.name, term);
      if (action.href !== location.href) {
        location.assign(action.href);
        return 'started';
      }
    }
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    return 'started';
  }
  // Some client-rendered sites use an input without an HTML search form.
  // Dispatch Enter, but never claim a supported native search if no input.
  for (const kind of ['keydown', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(kind, {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true
    }));
  }
  return 'started';
})()
"#;

const LOAD_MORE_SCRIPT: &str = r#"
(() => {
  for (const img of document.querySelectorAll('img[loading="lazy"]')) {
    img.loading = 'eager';
  }
  window.scrollBy(0, Math.max(window.innerHeight * 0.9, 500));
  return true;
})()
"#;

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

fn run_script(
    view: &tauri::Webview,
    script: &str,
    make_handler: impl FnOnce() -> ExecuteScriptCompletedHandler + Send + 'static,
) -> Result<(), String> {
    let source: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();
    view.with_webview(move |platform| {
        // COM handlers are constructed on the WebView2 UI thread.
        let handler = make_handler();
        let result = (|| -> windows::core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            unsafe { core.ExecuteScript(PCWSTR(source.as_ptr()), &handler)?; }
            Ok(())
        })();
        if let Err(err) = result {
            eprintln!("Haven Walls image inspection script error: {err}");
        }
    }).map_err(|_| "Could not access the isolated discovery browser.".to_string())
}

fn inspect_loaded_page(app: AppHandle, view: tauri::Webview, search_id: String)
    -> Result<(), String> {
    let result_app = app.clone();
    let id = search_id.clone();
    run_script(&view, browser_image_capture::SCAN_JS, move || {
        ExecuteScriptCompletedHandler::create(Box::new(
        move |completed, json| {
            match completed {
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
        }))
    })

}

fn load_more(view: &tauri::Webview) -> Result<(), String> {
    run_script(view, LOAD_MORE_SCRIPT, || {
        ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())))
    })
}

fn queue_scan(app: AppHandle, search_id: String, queued: Arc<AtomicBool>) {
    if queued.swap(true, Ordering::AcqRel) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        // Load ordinary results, then progressively request lazy image content
        // without blocking the WebView2 UI thread. No infinite scrolling.
        std::thread::sleep(Duration::from_millis(1100));
        let webview_label = format!("{PREFIX}{search_id}");
        for _ in 0..4 {
            if let Some(view) = app.get_webview(&webview_label) {
                let _ = load_more(&view);
            } else { return; }
            std::thread::sleep(Duration::from_millis(650));
        }
        if let Some(view) = app.get_webview(&webview_label) {
            if let Err(message) = inspect_loaded_page(
                app.clone(), view, search_id.clone()
            ) {
                report_error(&app, &search_id, message);
            }
        }
    });
}

fn start_native_search(
    app: AppHandle,
    search_id: String,
    keyword: String,
    queued: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(900));
        let webview_label = format!("{PREFIX}{search_id}");
        let Some(view) = app.get_webview(&webview_label) else { return; };
        let Ok(serialized) = serde_json::to_string(&keyword) else { return; };
        let script = NATIVE_SEARCH_SCRIPT.replace("__SEARCH_TERM__", &serialized);
        let callback_app = app.clone();
        let callback_id = search_id.clone();
        let callback_queued = queued.clone();
        let make_handler = move || {
            ExecuteScriptCompletedHandler::create(Box::new(
            move |completed, json| {
                let status: String = serde_json::from_str(&json).unwrap_or_default();
                if completed.is_err() || status != "started" {
                    report_error(&callback_app, &callback_id,
                        "Site-native search is unavailable on this page. Other search passes still run.");
                } else {
                    // SPA search interfaces may update without a page-load event.
                    // If a traditional GET form navigates, on_page_load schedules
                    // the scan sooner and this fallback becomes a no-op.
                    let fallback_app = callback_app.clone();
                    let fallback_id = callback_id.clone();
                    let fallback_queued = callback_queued.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        std::thread::sleep(Duration::from_millis(3800));
                        if fallback_app.get_webview(&format!("{PREFIX}{fallback_id}")).is_some() {
                            queue_scan(fallback_app, fallback_id, fallback_queued);
                        }
                    });
                }
                Ok(())
            },
            }))
        };
        if let Err(err) = run_script(&view, &script, make_handler) {
            report_error(&app, &search_id, err);
        }
    });
}

/// Opens one requested page and scans its loaded images. When native_query
/// is provided, first attempts the site's own GET search form or client search
/// control, and scans the resulting page instead of the homepage.
#[tauri::command]
pub async fn start_interest_page_search(
    app: AppHandle,
    search_id: String,
    url: String,
    native_query: Option<String>,
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
    let native_query = native_query.map(|term| term.trim().to_string());
    if native_query.as_ref().is_some_and(|term| term.is_empty() ||
        term.len() > 160 || term.chars().any(char::is_control)) {
        return Err("Site search must be a keyword of at most 160 characters.".into());
    }

    let parent = app.get_window("main")
        .ok_or_else(|| "Haven Walls main window is unavailable.".to_string())?;
    let paths = local_storage::current_paths(&app)?;
    let profile = paths.root.join("interest-discovery-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|_| "Could not prepare local discovery browser storage.".to_string())?;

    let load_app = app.clone();
    let id_for_load = search_id.clone();
    let first_load = Arc::new(AtomicBool::new(false));
    let first_for_load = first_load.clone();
    let scan_queued = Arc::new(AtomicBool::new(false));
    let queued_for_load = scan_queued.clone();
    let native_for_load = native_query.clone();
    let builder = WebviewBuilder::new(webview_label.clone(), WebviewUrl::External(parsed))
        .data_directory(profile)
        .on_navigation(allowed)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(move |_, event| {
            if !matches!(event.event(), PageLoadEvent::Finished) ||
                !allowed(event.url()) {
                return;
            }
            if let Some(term) = &native_for_load {
                if !first_for_load.swap(true, Ordering::AcqRel) {
                    start_native_search(
                        load_app.clone(), id_for_load.clone(), term.clone(),
                        queued_for_load.clone(),
                    );
                    return;
                }
            }
            queue_scan(load_app.clone(), id_for_load.clone(), queued_for_load.clone());
        });
    // Off-screen (not hidden) to let WebView2 render lazy-loaded images.
    // Browser tabs remain untouched and all results go to the Gallery grid.
    parent.add_child(
        builder, LogicalPosition::new(-12000.0, -12000.0),
        LogicalSize::new(1100.0, 700.0),
    ).map_err(|_| "Could not create the isolated discovery webview.".to_string())?;
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
    #[test]
    fn native_query_is_bounded() {
        assert!(NATIVE_SEARCH_SCRIPT.contains("__SEARCH_TERM__"));
        assert!(NATIVE_SEARCH_SCRIPT.contains("form.method.toLowerCase() !== 'get'"));
    }
}
