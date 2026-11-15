//! Commit 1: isolated, tabbed website browsing through native child WebView2.
//! Only the trusted Haven Walls main webview can call these commands.
//! Remote content gets no Tauri capabilities, scripts, or image/file access.
//! Save/scan, download policy and durable session data belong to later commits.

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

const PREFIX: &str = "hw-browser-tab-";
const EVENT: &str = "haven-browser-navigation";
const POPUP_EVENT: &str = "haven-browser-popup";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BrowserBounds {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height].into_iter().all(f64::is_finite)
            && self.x >= 0.0 && self.y >= 0.0
            && self.width >= 100.0 && self.height >= 90.0
            && self.width <= 6000.0 && self.height <= 6000.0
    }
}

fn label(tab_id: &str) -> Result<String, String> {
    if !(1..=36).contains(&tab_id.len())
        || !tab_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err("Invalid browser tab identifier.".into());
    }
    Ok(format!("{PREFIX}{tab_id}"))
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= 8192
}
fn target(input: &str) -> Result<tauri::Url, String> {
    if input.len() > 8192 {
        return Err("Browser address is too long.".into());
    }
    let parsed = tauri::Url::parse(input)
        .map_err(|_| "Enter a valid HTTP or HTTPS website address.".to_string())?;
    if !allowed_navigation(&parsed) {
        return Err("Only regular HTTP and HTTPS websites may be opened in the browser.".into());
    }
    Ok(parsed)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabEvent {
    tab_id: String,
    url: Option<String>,
    title: Option<String>,
    loading: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PopupEvent {
    opener_id: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabNavigationState {
    url: String,
    can_go_back: bool,
    can_go_forward: bool,
}

// Tauri's Webview exposes reload/navigation but not history inspection or
// GoBack/GoForward. Windows WebView2 exposes all three through CoreWebView2.
// Keep the native COM operation on the webview's UI thread. Await its result
// on a *blocking worker*, not the Tauri main thread, to avoid deadlocking UI.
#[cfg(windows)]
async fn native_history(
    view: &tauri::Webview, action: Option<&str>,
) -> Result<(bool, bool), String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::Win32::Foundation::BOOL;

    let (sender, receiver) = mpsc::sync_channel(1);
    let action = action.map(str::to_owned);
    view.with_webview(move |platform| {
        let result = (|| -> Result<(bool, bool), String> {
            let core = unsafe { platform.controller().CoreWebView2() }
                .map_err(|_| "Could not access the Windows WebView2 browser.".to_string())?;
            unsafe {
                let mut back = BOOL::default();
                let mut forward = BOOL::default();
                core.get_CanGoBack(&mut back)
                    .map_err(|_| "Could not read browser Back history.".to_string())?;
                core.get_CanGoForward(&mut forward)
                    .map_err(|_| "Could not read browser Forward history.".to_string())?;
                match action.as_deref() {
                    Some("back") if back.as_bool() => core.GoBack()
                        .map_err(|_| "Could not go back in this tab.".to_string())?,
                    Some("forward") if forward.as_bool() => core.GoForward()
                        .map_err(|_| "Could not go forward in this tab.".to_string())?,
                    Some("back" | "forward") | None => {},
                    _ => return Err("Unsupported browser navigation action.".into()),
                }
                // Navigation happens asynchronously. History state is updated
                // again when the page load event reaches the React shell.
                Ok((back.as_bool(), forward.as_bool()))
            }
        })();
        let _ = sender.send(result);
    }).map_err(|_| "Could not inspect the browser's native history.".to_string())?;

    tauri::async_runtime::spawn_blocking(move ||
        receiver.recv_timeout(Duration::from_secs(5))
    ).await.map_err(|_| "Browser history task was interrupted.".to_string())?
      .map_err(|_| "Browser history timed out.".to_string())?
}

#[cfg(not(windows))]
async fn native_history(
    _view: &tauri::Webview, _action: Option<&str>,
) -> Result<(bool, bool), String> {
    Err("Browser history navigation requires Windows WebView2.".into())
}

async fn navigation_state(view: &tauri::Webview) -> Result<TabNavigationState, String> {
    let (can_go_back, can_go_forward) = native_history(view, None).await?;
    Ok(TabNavigationState {
        url: view.url()
            .map_err(|_| "Browser URL is unavailable.".to_string())?
            .to_string(),
        can_go_back,
        can_go_forward,
    })
}

fn hide_all(app: &AppHandle) -> Result<(), String> {
    for (name, view) in app.webviews() {
        if name.starts_with(PREFIX) {
            view.hide().map_err(|_| "Could not hide a browser tab.".to_string())?;
        }
    }
    Ok(())
}

fn show_selected(app: &AppHandle, selected: &str, bounds: BrowserBounds) -> Result<(), String> {
    if !bounds.valid() {
        return Err("The browser viewing area is too small.".into());
    }
    hide_all(app)?;
    let view = app.get_webview(selected)
        .ok_or_else(|| "This browser tab has not loaded yet.".to_string())?;
    view.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|_| "Could not position the browser tab.".to_string())?;
    view.set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|_| "Could not resize the browser tab.".to_string())?;
    view.show().map_err(|_| "Could not display the browser tab.".to_string())
}

/// Creating native child webviews is async on Windows to avoid WebView2 deadlocks.
#[tauri::command]
pub async fn browser_open_tab(
    app: AppHandle, tab_id: String, url: String, bounds: BrowserBounds,
) -> Result<(), String> {
    let name = label(&tab_id)?;
    let parsed = target(&url)?;
    if !bounds.valid() {
        return Err("Make the browser area visible before opening a tab.".into());
    }
    if let Some(view) = app.get_webview(&name) {
        view.navigate(parsed)
            .map_err(|_| "Could not navigate this browser tab.".to_string())?;
        return show_selected(&app, &name, bounds);
    }
    // Limit native resources even if a faulty UI sends many creation requests.
    if app.webviews().keys().filter(|key| key.starts_with(PREFIX)).count() >= 12 {
        return Err("Close a browser tab before opening more than 12.".into());
    }
    let parent = app.get_window("main")
        .ok_or_else(|| "Haven Walls main window is unavailable.".to_string())?;
    let load_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let id_for_load = tab_id.clone();
    let id_for_title = tab_id.clone();
    let id_for_popup = tab_id.clone();
    let builder = WebviewBuilder::new(&name, WebviewUrl::External(parsed))
        .on_navigation(allowed_navigation)
        .on_page_load(move |_view, event| {
            let _ = load_app.emit_to("main", EVENT, TabEvent {
                tab_id: id_for_load.clone(),
                url: Some(event.url().to_string()),
                title: None,
                loading: Some(matches!(event.event(), PageLoadEvent::Started)),
            });
        })
        .on_document_title_changed(move |_view, title| {
            let _ = title_app.emit_to("main", EVENT, TabEvent {
                tab_id: id_for_title.clone(),
                url: None,
                title: Some(title.chars().take(180).collect()),
                loading: None,
            });
        })
        .on_new_window(move |popup, _features| {
            if allowed_navigation(&popup) {
                let _ = popup_app.emit_to("main", POPUP_EVENT, PopupEvent {
                    opener_id: id_for_popup.clone(),
                    url: popup.to_string(),
                });
            }
            // The shell opens a separate tab for website popups. WebView2 does
            // not yet preserve window.opener relationships in this workflow.
            NewWindowResponse::Deny
        });
    parent.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    ).map_err(|_| "Could not create a website WebView2 tab.".to_string())?;
    show_selected(&app, &name, bounds)
}

/// Passing null hides every Browser child while keeping all tabs in memory.
#[tauri::command]
pub fn browser_show_tab(
    app: AppHandle, tab_id: Option<String>, bounds: Option<BrowserBounds>,
) -> Result<(), String> {
    match (tab_id, bounds) {
        (Some(id), Some(rect)) => show_selected(&app, &label(&id)?, rect),
        (None, None) => hide_all(&app),
        _ => Err("A browser tab and its bounds must be provided together.".into()),
    }
}

#[tauri::command]
pub fn browser_navigate_tab(
    app: AppHandle, tab_id: String, url: String,
) -> Result<(), String> {
    let view = app.get_webview(&label(&tab_id)?)
        .ok_or_else(|| "Browser tab is unavailable.".to_string())?;
    view.navigate(target(&url)?)
        .map_err(|_| "Could not navigate to the requested website.".to_string())
}

#[tauri::command]
pub async fn browser_tab_action(
    app: AppHandle, tab_id: String, action: String,
) -> Result<TabNavigationState, String> {
    let view = app.get_webview(&label(&tab_id)?)
        .ok_or_else(|| "Browser tab is unavailable.".to_string())?;
    match action.as_str() {
        "back" | "forward" => {
            native_history(&view, Some(&action)).await?;
        }
        "reload" => {
            view.reload().map_err(|_| "Could not reload this browser tab.".to_string())?;
        }
        _ => return Err("Unsupported browser navigation action.".into()),
    }
    navigation_state(&view).await
}

#[tauri::command]
pub async fn browser_tab_state(
    app: AppHandle, tab_id: String,
) -> Result<TabNavigationState, String> {
    let view = app.get_webview(&label(&tab_id)?)
        .ok_or_else(|| "Browser tab is unavailable.".to_string())?;
    navigation_state(&view).await
}

#[tauri::command]
pub fn browser_close_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(view) = app.get_webview(&label(&tab_id)?) {
        view.close().map_err(|_| "Could not close the browser tab.".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn web_urls_only() {
        assert!(target("https://www.google.com/").is_ok());
        assert!(target("http://example.org/").is_ok());
        assert!(target("file:///C:/Windows/system.ini").is_err());
        assert!(target("javascript:alert(1)").is_err());
        assert!(target("https://user:password@example.com").is_err());
    }
    #[test]
    fn labels_cannot_escape_browser_namespace() {
        assert!(label("tab-123").is_ok());
        assert!(label("../main").is_err());
        assert!(label("www.example.com").is_err());
    }
}
