//! A real Google Images webview embedded in the existing Haven Walls window.
//! Navigation remains within Google's own HTTPS origins. No DOM injection,
//! scraping, or IPC permission is granted to untrusted Google content.
use serde::Deserialize;
use crate::wallpaper_library;
use reqwest::header::{CONTENT_TYPE, LOCATION};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

const WEBVIEW_LABEL: &str = "google-images-inline";

#[derive(Debug, Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BrowserBounds {
    fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width >= 100.0
            && self.height >= 90.0
            && self.width <= 5000.0
            && self.height <= 5000.0
    }
}

fn google_images_url(query: &str) -> Result<tauri::Url, String> {
    let term = query.trim();
    if !(2..=100).contains(&term.chars().count()) {
        return Err("Enter a search between 2 and 100 characters.".to_string());
    }
    let mut url = tauri::Url::parse("https://www.google.com/search")
        .map_err(|_| "Could not prepare Google Images search".to_string())?;
    url.query_pairs_mut()
        .append_pair("tbm", "isch")
        .append_pair("q", term)
        .append_pair("safe", "active");
    Ok(url)
}

fn allow_google_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some(
                "www.google.com"
                    | "google.com"
                    | "images.google.com"
                    | "consent.google.com"
                    | "accounts.google.com"
                    | "lens.google.com"
            )
        )
}

/// Open or navigate the single inline Google Images child webview.
/// Async is required by WebView2 when creating child webviews on Windows.
#[tauri::command]
pub async fn open_google_images_inline(
    app: AppHandle,
    query: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    if !bounds.is_valid() {
        return Err("The embedded browser area is not visible. Scroll to it first.".into());
    }
    let url = google_images_url(&query)?;
    open_google_webview_at_url(app, url, bounds).await
}

/// Navigates to a *Google-owned* Lens results URL or the manual Google Images
/// upload screen. URLs supplied by arbitrary websites are never accepted.
#[tauri::command]
pub async fn open_google_lens_inline(
    app: AppHandle, url: String, bounds: BrowserBounds,
) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url)
        .map_err(|_| "Invalid Google Lens address.".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" ||
        !matches!(host, "www.google.com" | "google.com" | "lens.google.com") ||
        !parsed.username().is_empty() || parsed.password().is_some() ||
        url.len() > 8192 {
        return Err("Google Lens returned an unsupported destination.".into());
    }
    // Never navigate the embedded browser to a publisher or arbitrary URL.
    if host == "lens.google.com" && !parsed.path().starts_with("/search") {
        return Err("Google Lens did not return a search results page.".into());
    }
    if host != "lens.google.com" &&
        parsed.path() != "/imghp" && parsed.path() != "/search" {
        return Err("Google Lens returned an unexpected Google page.".into());
    }
    open_google_webview_at_url(app, parsed, bounds).await
}

async fn open_google_webview_at_url(
    app: AppHandle, url: tauri::Url, bounds: BrowserBounds,
) -> Result<(), String> {
    if !bounds.is_valid() {
        return Err("The embedded browser area is not visible. Scroll to it first.".into());
    }

    if let Some(view) = app.get_webview(WEBVIEW_LABEL) {
        view.navigate(url)
            .map_err(|_| "Could not navigate the embedded Google browser".to_string())?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|_| "Could not resize the embedded browser".to_string())?;
        view.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|_| "Could not position the embedded browser".to_string())?;
        view.show().map_err(|_| "Could not show the embedded browser".to_string())?;
        return Ok(());
    }

    let parent = app.get_window("main")
        .ok_or_else(|| "Haven Walls main window is unavailable".to_string())?;
    let builder = WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(url))
        .on_navigation(allow_google_navigation)
        .on_new_window(|_, _| NewWindowResponse::Deny);
    let child = parent
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|_| {
            "Could not embed Google Images in WebView2. Google may restrict embedded browsing."
                .to_string()
        })?;

    #[cfg(windows)]
    {
        use tauri::Emitter;
        // No permissions are given to Google's webview. WebView2 itself adds
        // one command to its native image context menu and emits a typed
        // selection event to the local main UI only when the user clicks it.
        let context_app = app.clone();
        child
            .with_webview(move |platform| {
                let result = unsafe {
                    platform
                        .controller()
                        .CoreWebView2()
                        .and_then(|core| crate::google_context_menu::register(&core, context_app.clone()))
                };
                match result {
                    Ok(()) => {
                        let _ = context_app.emit_to(
                            "main",
                            crate::google_context_menu::CONTEXT_MENU_STATUS_EVENT,
                            "Native right-click image action attached. Right-click a Google photo to try it.",
                        );
                    }
                    Err(error) => {
                        let _ = context_app.emit_to(
                            "main",
                            crate::google_context_menu::CONTEXT_MENU_ERROR_EVENT,
                            format!("Native image context menu unavailable: {error}"),
                        );
                    }
                }
            })
            .map_err(|_| "Could not attach the Google Images context menu.".to_string())?;
    }

    Ok(())
}


/// User-initiated reverse image lookup using the exact saved Library bytes.
/// Google's upload endpoint is not a public API: return an actionable error
/// if it changes or denies the request instead of pretending a match exists.
/// We never scrape, store results, or send the image to a third-party proxy.
#[tauri::command]
pub async fn upload_library_wallpaper_to_lens(
    app: AppHandle, image_id: String,
) -> Result<String, String> {
    let (bytes, mime) = tauri::async_runtime::spawn_blocking(move ||
        wallpaper_library::lens_wallpaper_bytes(&app, &image_id)
    ).await.map_err(|_| "Reading the Library image was interrupted.".to_string())??;

    let extension = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "System time is unavailable.".to_string())?.as_nanos();
    let boundary = format!("haven-walls-lens-{:x}", suffix);
    let header = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"encoded_image\"; filename=\"wallpaper.{extension}\"\r\nContent-Type: {mime}\r\n\r\n"
    );
    let footer = format!(
        "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"sbisrc\"\r\n\r\nGoogle Chrome\r\n--{boundary}--\r\n"
    );
    let mut body = Vec::with_capacity(header.len() + bytes.len() + footer.len());
    body.extend_from_slice(header.as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(footer.as_bytes());

    // Never forward the uploaded bytes to arbitrary redirect targets.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36")
        .build().map_err(|e| format!("Could not create Lens upload request: {e}"))?;
    let endpoint = reqwest::Url::parse("https://lens.google.com/v3/upload")
        .map_err(|_| "Invalid Google Lens endpoint.".to_string())?;
    let response = client.post(endpoint.clone())
        .header(CONTENT_TYPE, format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send().await.map_err(|e| format!("Google Lens upload request failed: {e}"))?;
    if !response.status().is_redirection() {
        return Err(format!(
            "Google Lens did not accept the image automatically (HTTP {}). Use the upload file option below.",
            response.status()
        ));
    }
    let location = response.headers().get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or("Google Lens did not return a results address.")?;
    let results = endpoint.join(location)
        .map_err(|_| "Google Lens returned an invalid results address.".to_string())?;
    let host = results.host_str().unwrap_or("");
    let path = results.path();
    if results.scheme() != "https" ||
        !matches!(host, "www.google.com" | "google.com" | "lens.google.com") ||
        !(path == "/search" || path.starts_with("/search/")) ||
        results.as_str().len() > 8192 {
        return Err("Google Lens redirected to an unsupported page. Use the manual upload option.".into());
    }
    Ok(results.to_string())
}

/// Keep the native child in the visible portion of the React browser slot.
/// Hide it for modals, other tabs, and when the slot scrolls off-screen.
#[tauri::command]
pub fn layout_google_images_inline(
    app: AppHandle,
    bounds: Option<BrowserBounds>,
) -> Result<(), String> {
    let Some(view) = app.get_webview(WEBVIEW_LABEL) else {
        return Ok(());
    };
    let Some(bounds) = bounds.filter(BrowserBounds::is_valid) else {
        return view.hide().map_err(|_| "Could not hide the embedded browser".to_string());
    };

    view.set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|_| "Could not resize the embedded browser".to_string())?;
    view.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|_| "Could not position the embedded browser".to_string())?;
    view.show().map_err(|_| "Could not show the embedded browser".to_string())
}

/// Zoom affects only Google's isolated embedded webview, not Haven Walls.
#[tauri::command]
pub fn set_google_images_inline_zoom(app: AppHandle, zoom: f64) -> Result<(), String> {
    if !zoom.is_finite() || !(0.5..=2.0).contains(&zoom) {
        return Err("Embedded browser zoom must be between 50% and 200%.".into());
    }
    let Some(view) = app.get_webview(WEBVIEW_LABEL) else {
        return Ok(()); // The chosen zoom will be applied when the browser is opened.
    };
    view.set_zoom(zoom)
        .map_err(|_| "Could not change Google Images browser zoom.".to_string())
}

#[tauri::command]
pub fn close_google_images_inline(app: AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview(WEBVIEW_LABEL) {
        view.close().map_err(|_| "Could not close the embedded browser".to_string())?;
    }
    Ok(())
}
