//! Windows-only WebView2 image capture for Haven Walls Browser tabs.
//! Copy the proven native context-menu pattern from google_context_menu.rs.
//! The browser remains unprivileged; image URLs reach only the trusted shell.
#![cfg(windows)]

use std::net::IpAddr;
use tauri::{AppHandle, Emitter, Manager};
use webview2_com::{
    take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
        ICoreWebView2, ICoreWebView2Environment9, ICoreWebView2_11,
    },
};
use windows::{
    core::{BOOL, Interface, PWSTR, w},
    Win32::System::Com::IStream,
};

pub const IMAGE_PICKED_EVENT: &str = "haven-browser-image-picked";
pub const CONTEXT_MENU_ERROR_EVENT: &str = "haven-browser-image-error";
pub const CONTEXT_MENU_STATUS_EVENT: &str = "haven-browser-image-status";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserImagePicked {
    tab_id: String,
    image_url: String,
    page_url: String,
    link_url: String,
}

pub(crate) fn validated_web_url(raw: &str) -> Option<String> {
    if raw.len() > 4096 {
        return None;
    }
    let url = tauri::Url::parse(raw).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || !host.contains('.')
        || host == "localhost" || host.ends_with(".localhost")
        || host.ends_with(".local") || host.ends_with(".internal")
        || host.parse::<IpAddr>().is_ok()
    {
        return None;
    }
    Some(url.to_string())
}

fn read_com_string(
    action: impl FnOnce(&mut PWSTR) -> windows::core::Result<()>,
) -> String {
    let mut raw = PWSTR::null();
    match action(&mut raw) {
        Ok(()) => take_pwstr(raw),
        Err(_) => String::new(),
    }
}

fn is_google_image_result_link(raw: &str) -> bool {
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    matches!(host, "google.com" | "www.google.com" | "images.google.com")
        && url.path().starts_with("/imgres")
        && url.query_pairs().any(|(key, value)| key == "imgurl" && value.starts_with("https://"))
}

/// Register once per new Browser child webview. No remote Tauri capabilities.
pub unsafe fn register(core: &ICoreWebView2, app: AppHandle, tab_id: String) -> windows::core::Result<()> {
    let webview11 = core.cast::<ICoreWebView2_11>()?;
    let app_for_menu = app.clone();
    let tab_id_for_menu = tab_id;

    let handler = ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
        let attempt = (|| -> windows::core::Result<()> {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let target = unsafe { args.ContextMenuTarget()? };
            let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
            unsafe { target.Kind(&mut kind)?; }

            // An <img> wrapped in Google's link may be identified as a link
            // rather than IMAGE. Accept a usable source URI regardless of Kind.
            let mut has_source = BOOL::default();
            unsafe { target.HasSourceUri(&mut has_source)?; }
            let source = if has_source.as_bool() {
                read_com_string(|output| unsafe { target.SourceUri(output) })
            } else {
                String::new()
            };

            let mut has_link = BOOL::default();
            unsafe { target.HasLinkUri(&mut has_link)?; }
            let link = if has_link.as_bool() {
                read_com_string(|output| unsafe { target.LinkUri(output) })
            } else {
                String::new()
            };

            let source_uri = validated_web_url(&source).unwrap_or_default();
            let link_uri = validated_web_url(&link).unwrap_or_default();

            // On blob/data image targets we still show a helpful error rather
            // than offering a publisher webpage as a downloadable image.
            if kind != COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE
                && source_uri.is_empty()
                && !is_google_image_result_link(&link_uri)
            {
                return Ok(());
            }

            let page = read_com_string(|output| unsafe { target.PageUri(output) });
            let page_uri = validated_web_url(&page).unwrap_or_default();

            // Google imgres links can be unwrapped by the trusted React image
            // resolver. Other sites normally provide a direct SourceUri.
            let chosen = if !source_uri.is_empty() {
                source_uri
            } else if is_google_image_result_link(&link_uri) {
                link_uri.clone()
            } else {
                String::new()
            };

            let environment = unsafe {
                sender.cast::<ICoreWebView2_11>()?
                    .Environment()?
                    .cast::<ICoreWebView2Environment9>()?
            };
            let menu = unsafe {
                environment.CreateContextMenuItem(
                    w!("Add to Haven Walls review"),
                    None::<&IStream>,
                    COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
                )?
            };

            let app_for_selection = app_for_menu.clone();
            let selected_tab = tab_id_for_menu.clone();
            let on_selection = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                // A link-wrapped image can have a publisher LinkUri while
                // SourceUri is a thumbnail or absent. Never treat the
                // publisher page itself as a downloadable image.
                if chosen.is_empty() && link_uri.is_empty() {
                    let _ = app_for_selection.emit_to(
                        "main",
                        CONTEXT_MENU_ERROR_EVENT,
                        "This website did not supply an image URL for the selected element. Try Copy image link.",
                    );
                } else {
                    let _ = app_for_selection.emit_to(
                        "main", IMAGE_PICKED_EVENT,
                        BrowserImagePicked {
                            tab_id: selected_tab.clone(),
                            image_url: chosen.clone(),
                            page_url: page_uri.clone(),
                            link_url: link_uri.clone(),
                        },
                    );
                }
                Ok(())
            }));
            let mut token = 0i64;
            unsafe { menu.add_CustomItemSelected(&on_selection, &mut token)?; }

            let entries = unsafe { args.MenuItems()? };
            // Place Haven Walls at the top of the website's native image menu.
            unsafe { entries.InsertValueAtIndex(0, &menu)?; }
            Ok(())
        })();

        if let Err(error) = attempt {
            let _ = app_for_menu.emit_to(
                "main", CONTEXT_MENU_ERROR_EVENT,
                format!("Could not add the native image menu item: {error}"),
            );
        }
        // Do not suppress WebView2's other context-menu actions.
        Ok(())
    }));

    let mut token = 0i64;
    unsafe { webview11.add_ContextMenuRequested(&handler, &mut token)?; }
    Ok(())
}


// Explicit, per-click on-demand DOM inspection. No scripts persist on pages.
// Bounds limit both UI latency and remote page metadata exposure. Only URL,
// alt/title and image dimensions are returned; never page HTML or form data.
pub const SCAN_JS: &str = r#"
(() => {
  const pageUrl = location.href;
  const hits = [];
  const seen = new Set();
  const acceptable = (raw) => {
    if (!raw || typeof raw !== 'string' || raw.length > 4096) return '';
    try {
      const u = new URL(raw, document.baseURI);
      return u.protocol === 'https:' && !u.username && !u.password ? u.href : '';
    } catch { return ''; }
  };
  const bestSrcset = (srcset) => {
    if (!srcset) return '';
    const parts = srcset.split(',').map(x => x.trim()).filter(Boolean);
    const choices = parts.map(part => {
      const tokens = part.split(/\s+/);
      const score = Number.parseFloat(tokens[1] || '1') || 1;
      return { url: acceptable(tokens[0]), score };
    }).filter(x => x.url);
    choices.sort((a, b) => b.score - a.score);
    return choices[0]?.url || '';
  };
  const originalFromLink = (element) => {
    const href = element.closest('a[href]')?.href;
    if (!href) return '';
    try {
      const link = new URL(href);
      for (const key of ['imgurl', 'mediaurl', 'image_url']) {
        const original = acceptable(link.searchParams.get(key));
        if (original) return original;
      }
      if (/\.(?:png|jpe?g|webp|avif)(?:$|[?#])/i.test(link.pathname)) return acceptable(href);
    } catch {}
    return '';
  };
  const add = (src, original, title, width, height) => {
    const url = acceptable(src);
    if (!url || seen.has(url)) return;
    const best = acceptable(original);
    const w = Math.min(Math.max(Number(width) || 0, 0), 20000) | 0;
    const h = Math.min(Math.max(Number(height) || 0, 0), 20000) | 0;
    // Obvious icons, tracking pixels and emoji avatars are not wallpapers.
    if ((w && w < 96) || (h && h < 96)) return;
    if (hits.length >= 160) return;
    seen.add(url);
    hits.push({ url, originalUrl: best && best !== url ? best : null,
      title: String(title || 'Website image').slice(0, 150),
      width: w, height: h });
  };
  Array.from(document.images).slice(0, 750).forEach(img => {
    const source = acceptable(img.currentSrc) || acceptable(img.src)
      || acceptable(img.getAttribute('data-src')) || acceptable(img.getAttribute('data-original'));
    const original = originalFromLink(img) || bestSrcset(img.srcset)
      || bestSrcset(img.getAttribute('data-srcset'))
      || acceptable(img.getAttribute('data-original'))
      || acceptable(img.getAttribute('data-full'))
      || source;
    add(source || original, original, img.alt || img.title || document.title,
      img.naturalWidth, img.naturalHeight);
  });
  Array.from(document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]'))
    .slice(0, 6).forEach(meta => add(meta.content, meta.content,
      document.title, 0, 0));
  Array.from(document.querySelectorAll('[style*="background"]')).slice(0, 300)
    .forEach(el => {
      const style = el.style.backgroundImage || '';
      const match = /url\((["']?)(.*?)\1\)/i.exec(style);
      if (match) add(match[2], match[2], el.getAttribute('aria-label')
        || el.title || document.title, el.clientWidth, el.clientHeight);
    });
  return { pageUrl, images: hits };
})()
"#;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedImage {
    url: String,
    original_url: Option<String>,
    title: String,
    width: u32,
    height: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPageScan {
    page_url: String,
    images: Vec<ScannedImage>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageScanResponse {
    tab_id: String,
    page_url: String,
    images: Vec<ScannedImage>,
    skipped: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageScanError {
    tab_id: String,
    message: String,
}

pub const SCAN_RESULTS_EVENT: &str = "haven-browser-scan-results";
pub const SCAN_ERROR_EVENT: &str = "haven-browser-scan-error";

// Even an untrusted remote page's DOM output is validated again in Rust.
fn parse_scan(raw: &str, tab_id: String) -> Result<PageScanResponse, String> {
    if raw.len() > 512 * 1024 {
        return Err("This page returned too many image URLs to scan safely.".into());
    }
    let data: RawPageScan = serde_json::from_str(raw)
        .map_err(|_| "The page did not provide readable image metadata.".to_string())?;
    let page_url = validated_web_url(&data.page_url)
        .ok_or_else(|| "The website address could not be verified.".to_string())?;
    let mut images = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut skipped = 0usize;
    for entry in data.images.into_iter().take(160) {
        if let Some(url) = validated_web_url(&entry.url) {
            if seen.insert(url.clone()) {
                let original_url = entry.original_url.as_deref()
                    .and_then(validated_web_url).filter(|original| original != &url);
                images.push(ScannedImage {
                    url,
                    original_url,
                    title: entry.title.chars().take(150).collect(),
                    width: entry.width.min(20000),
                    height: entry.height.min(20000),
                });
            } else { skipped += 1; }
        } else { skipped += 1; }
    }
    Ok(PageScanResponse { tab_id, page_url, images, skipped })
}

/// Must run from the trusted host only, after the user clicks "Find images".
/// The page is queried once and receives no JavaScript bridge or IPC access.
#[tauri::command]
pub fn browser_scan_images(app: AppHandle, tab_id: String) -> Result<(), String> {
    // Reuse the same id validation used by tab commands.
    let name = crate::internal_browser::label(&tab_id)?;
    let view = app.get_webview(&name)
        .ok_or_else(|| "Select an already loaded browser tab first.".to_string())?;
    let scan_app = app.clone();
    view.with_webview(move |platform| {
        let launched = (|| -> windows::core::Result<()> {
            let core = unsafe { platform.controller().CoreWebView2()? };
            let event_app = scan_app.clone();
            let event_tab = tab_id.clone();
            let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(
                move |completed, json| {
                    let result = match completed {
                        Ok(()) => parse_scan(&json, event_tab.clone()),
                        Err(_) => Err("WebView2 could not inspect this website.".to_string()),
                    };
                    match result {
                        Ok(images) => {
                            let _ = event_app.emit_to("main", SCAN_RESULTS_EVENT, images);
                        }
                        Err(message) => {
                            let _ = event_app.emit_to("main", SCAN_ERROR_EVENT,
                                PageScanError { tab_id: event_tab.clone(), message });
                        }
                    }
                    Ok(())
                },
            ));
            let utf16: Vec<u16> = SCAN_JS.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                core.ExecuteScript(windows::core::PCWSTR(utf16.as_ptr()), &handler)?;
            }
            Ok(())
        })();
        if let Err(error) = launched {
            let _ = scan_app.emit_to("main", SCAN_ERROR_EVENT, PageScanError {
                tab_id,
                message: format!("Could not start website image scanning: {error}"),
            });
        }
    }).map_err(|_| "Could not access this WebView2 tab for image scanning.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_filters_bad_urls_and_duplicate_entries() {
        let raw = r#"{"pageUrl":"https://example.com/", "images":[
            {"url":"https://cdn.example.com/a.png","originalUrl":null,"title":"A","width":2000,"height":1200},
            {"url":"https://cdn.example.com/a.png","originalUrl":null,"title":"B","width":2000,"height":1200},
            {"url":"file:///c:/secret","originalUrl":null,"title":"C","width":400,"height":300}
        ]}"#;
        let result = parse_scan(raw, "t-1".into()).expect("valid metadata");
        assert_eq!(result.images.len(), 1);
        assert_eq!(result.skipped, 2);
    }
    #[test]
    fn rejects_private_url_and_giant_input() {
        assert!(validated_web_url("http://localhost/image.png").is_none());
        assert!(validated_web_url("https://127.0.0.1/image.png").is_none());
        assert!(parse_scan("bad json", "t-1".into()).is_err());
    }
}
