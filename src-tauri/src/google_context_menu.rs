//! Windows-only WebView2 image context-menu command.
//! Host API is used, not JavaScript injected into third-party Google pages.
#![cfg(windows)]

use std::net::IpAddr;
use tauri::{AppHandle, Emitter};
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

pub const IMAGE_PICKED_EVENT: &str = "google-image-picked";
pub const CONTEXT_MENU_ERROR_EVENT: &str = "google-image-menu-error";
pub const CONTEXT_MENU_STATUS_EVENT: &str = "google-image-menu-status";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserImagePicked {
    image_url: String,
    page_url: String,
    link_url: String,
}

fn validated_web_url(raw: &str) -> Option<String> {
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

/// Register once per new Google child webview. The webview remains isolated
/// from native Tauri capabilities; only host-owned WebView2 events are used.
pub unsafe fn register(core: &ICoreWebView2, app: AppHandle) -> windows::core::Result<()> {
    let webview11 = core.cast::<ICoreWebView2_11>()?;
    let app_for_menu = app.clone();

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

            // Display the menu item on native image targets even if Google
            // only supplied a blob/data thumbnail; in that case the user gets
            // an explicit explanation instead of a mysteriously missing item.
            if kind != COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE
                && source_uri.is_empty()
                && !is_google_image_result_link(&link_uri)
            {
                return Ok(());
            }

            let page = read_com_string(|output| unsafe { target.PageUri(output) });
            let page_uri = validated_web_url(&page).unwrap_or_default();

            // If Google exposes an original image in an imgres link, it can
            // be unwrapped by the local review workflow. Otherwise pass the
            // direct image URI if available, including Google cached thumbnails.
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
            let on_selection = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                if chosen.is_empty() {
                    let _ = app_for_selection.emit_to(
                        "main",
                        CONTEXT_MENU_ERROR_EVENT,
                        "This Google image has no direct HTTPS image URL. Try Copy image link or open its original source website.",
                    );
                } else {
                    let _ = app_for_selection.emit_to(
                        "main", IMAGE_PICKED_EVENT,
                        BrowserImagePicked {
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
            // Place Haven Walls at the top so it is immediately visible,
            // rather than below Google's long "More tools" submenu.
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
