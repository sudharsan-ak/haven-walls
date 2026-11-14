//! A real Google Images webview embedded in the existing Haven Walls window.
//! Navigation stays within Google's HTTPS origins. A one-shot browser-owned
//! form submits a user-selected image to Lens; no scraping or IPC permission
//! is granted to Google or other remote content.
use serde::Deserialize;
use crate::wallpaper_library;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::Emitter;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

const WEBVIEW_LABEL: &str = "google-images-inline";

#[derive(Default)]
pub struct PendingLensUpload(pub Mutex<Option<String>>);

/// A user-initiated form post from Google's own browser session. No Tauri
/// permissions are granted to Google or other remote content.
const LENS_FORM_SCRIPT: &str = r#"
(() => {
  if (!['www.google.com', 'google.com'].includes(location.hostname) ||
      location.pathname !== '/imghp' || !document.body) return;
  const binary = atob('__LENS_JPEG_BASE64__');
  const pixels = new Uint8Array(binary.length);
  for (let n = 0; n < binary.length; n++) pixels[n] = binary.charCodeAt(n);
  const form = document.createElement('form');
  form.action = 'https://lens.google.com/v3/upload?ep=ccm&s=&st=' + Date.now();
  form.method = 'POST';
  form.enctype = 'multipart/form-data';
  form.style.display = 'none';
  const upload = document.createElement('input');
  upload.type = 'file';
  upload.name = 'encoded_image';
  const transfer = new DataTransfer();
  transfer.items.add(new File([pixels], 'haven-walls-image.jpg', { type: 'image/jpeg' }));
  upload.files = transfer.files;
  form.appendChild(upload);
  const source = document.createElement('input');
  source.type = 'hidden';
  source.name = 'sbisrc';
  source.value = 'Google Chrome';
  form.appendChild(source);
  document.body.appendChild(form);
  form.submit();
})();
"#;

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
    let load_app = app.clone();
    let builder = WebviewBuilder::new(WEBVIEW_LABEL, WebviewUrl::External(url))
        .on_navigation(allow_google_navigation)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) ||
                payload.url().host_str() != Some("www.google.com") ||
                payload.url().path() != "/imghp" {
                return;
            }
            let state = load_app.state::<PendingLensUpload>();
            let pending = state.0.lock().ok().and_then(|mut value| value.take());
            if let Some(script) = pending {
                // The image goes only to the Google image-upload page. This
                // script is one-shot and never injected into other websites.
                if webview.eval(script).is_err() {
                    let _ = load_app.emit_to("main", "google-lens-upload-error",
                        "Google Lens could not submit the image from the browser. Use Manual upload instead.");
                }
            }
        });
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


/// Upload a user-selected saved Library photo in the same WebView2 session
/// that will display Google's results. The original file is never modified.
#[tauri::command]
pub async fn reverse_search_library_wallpaper_inline(
    app: AppHandle, image_id: String, bounds: BrowserBounds,
) -> Result<(), String> {
    if !bounds.is_valid() {
        return Err("Scroll the embedded browser into view before reverse searching.".into());
    }
    let file_app = app.clone();
    let encoded = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (bytes, _) = wallpaper_library::lens_wallpaper_bytes(&file_app, &image_id)?;
        let image = image::load_from_memory(&bytes)
            .map_err(|e| format!("Could not decode the saved wallpaper for Lens: {e}"))?;
        // Visual matching does not require the full 4K/8K original. The JPEG
        // copy is kept in memory for this one explicit search only.
        let preview = image.thumbnail(1600, 1600);
        let mut encoded = Cursor::new(Vec::new());
        preview.write_to(&mut encoded, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Could not prepare the Lens preview: {e}"))?;
        Ok(BASE64.encode(encoded.into_inner()))
    }).await.map_err(|_| "Could not prepare the Lens image.".to_string())??;
    if encoded.len() > 10 * 1024 * 1024 {
        return Err("The Lens preview is too large to submit.".into());
    }
    let state = app.state::<PendingLensUpload>();
    {
        let mut slot = state.0.lock()
            .map_err(|_| "Google Lens upload is temporarily unavailable.".to_string())?;
        *slot = Some(LENS_FORM_SCRIPT.replace("__LENS_JPEG_BASE64__", &encoded));
    }
    let url = tauri::Url::parse("https://www.google.com/imghp")
        .map_err(|_| "Could not prepare the Google Lens image-upload page.".to_string())?;
    if let Err(error) = open_google_webview_at_url(app.clone(), url, bounds).await {
        if let Ok(mut slot) = state.0.lock() { *slot = None; }
        return Err(error);
    }
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
