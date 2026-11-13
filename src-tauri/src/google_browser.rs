//! A real Google Images webview embedded in the existing Haven Walls window.
//! Navigation remains within Google's own HTTPS origins. No DOM injection,
//! scraping, or IPC permission is granted to untrusted Google content.
use serde::Deserialize;
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
    parent
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|_| {
            "Could not embed Google Images in WebView2. Google may restrict embedded browsing."
                .to_string()
        })?;

    Ok(())
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
