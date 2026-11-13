//! Open a separate, isolated webview for user-driven Google Images searches.
//! Remote pages do not receive the native capabilities assigned to the main UI.
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn allowed_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("www.google.com" | "google.com" | "consent.google.com" | "accounts.google.com")
        )
}

#[tauri::command]
pub async fn open_google_images_browser(
    app: tauri::AppHandle,
    query: String,
) -> Result<(), String> {
    let query = query.trim();
    if !(2..=100).contains(&query.chars().count()) {
        return Err("Enter a search between 2 and 100 characters.".into());
    }

    let mut url = tauri::Url::parse("https://www.google.com/search")
        .map_err(|_| "Could not prepare the Google Images URL".to_string())?;
    url.query_pairs_mut()
        .append_pair("tbm", "isch")
        .append_pair("q", query)
        .append_pair("safe", "active");

    if let Some(window) = app.get_webview_window("google-images-browser") {
        window.navigate(url)
            .map_err(|_| "Could not navigate the Google Images window".to_string())?;
        window.show()
            .map_err(|_| "Could not display the Google Images window".to_string())?;
        window.set_focus()
            .map_err(|_| "Could not focus the Google Images window".to_string())?;
        return Ok(());
    }

    // Must be an async command on Windows WebView2 to avoid deadlocking.
    // Only the "main" label is assigned native Tauri capabilities.
    WebviewWindowBuilder::new(
        &app,
        "google-images-browser",
        WebviewUrl::External(url),
    )
    .title("Google Images | Haven Walls (manual browsing)")
    .inner_size(1120.0, 780.0)
    .min_inner_size(780.0, 560.0)
    .resizable(true)
    .on_navigation(allowed_navigation)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()
    .map_err(|_| "Could not open the Google Images WebView2 window. Google may restrict embedded browsers.".to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_external_page_navigation() {
        assert!(allowed_navigation(&tauri::Url::parse("https://www.google.com/search").unwrap()));
        assert!(!allowed_navigation(&tauri::Url::parse("https://www.google.com.evil.example/").unwrap()));
        assert!(!allowed_navigation(&tauri::Url::parse("http://www.google.com/").unwrap()));
    }
}
