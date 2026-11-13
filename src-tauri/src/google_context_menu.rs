//! Windows-only WebView2 native context menu customization.
//! Adds a single explicit user action to images shown in Google's isolated webview.
//! Uses the browser's context-menu target metadata, not page script injection.
#![cfg(windows)]

use std::net::IpAddr;

use tauri::{AppHandle, Emitter};
use webview2_com::{
    ContextMenuRequestedEventHandler,
    CustomItemSelectedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
        ICoreWebView2,
        ICoreWebView2Environment9,
        ICoreWebView2_11,
    },
    take_pwstr,
};
use windows::{
    core::{BOOL, Interface, PWSTR, w},
    Win32::System::Com::IStream,
};

pub const IMAGE_PICKED_EVENT: &str = "google-image-picked";
pub const CONTEXT_MENU_ERROR_EVENT: &str = "google-image-menu-error";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserImagePicked {
    image_url: String,
    page_url: String,
}

fn valid_remote_image_url(raw: &str) -> bool {
    if raw.len() > 4096 {
        return false;
    }
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let lower = host.to_ascii_lowercase();
    !lower.is_empty()
        && lower.contains('.')
        && lower != "localhost"
        && !lower.ends_with(".localhost")
        && !lower.ends_with(".local")
        && !lower.ends_with(".internal")
        && lower.parse::<IpAddr>().is_err()
}

/// Called once for each newly created Google child WebView2. COM events
/// are registered on the UI thread through Tauri's with_webview callback.
pub unsafe fn register(
    core: &ICoreWebView2,
    app: AppHandle,
) -> windows::core::Result<()> {
    let webview11 = core.cast::<ICoreWebView2_11>()?;
    let environment = webview11.Environment()?.cast::<ICoreWebView2Environment9>()?;

    let menu_handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let target = unsafe { args.ContextMenuTarget()? };
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
        unsafe { target.Kind(&mut kind)?; }
        if kind != COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE {
            return Ok(());
        }

        let mut has_source = BOOL::default();
        unsafe { target.HasSourceUri(&mut has_source)?; }
        if !has_source.as_bool() {
            return Ok(());
        }

        let mut raw_url = PWSTR::null();
        unsafe { target.SourceUri(&mut raw_url)?; }
        let image_url = take_pwstr(raw_url);
        if !valid_remote_image_url(&image_url) {
            return Ok(());
        }

        let mut raw_page_url = PWSTR::null();
        let page_url = if unsafe { target.PageUri(&mut raw_page_url) }.is_ok() {
            let url = take_pwstr(raw_page_url);
            if url.starts_with("https://") && url.len() <= 4096 {
                url
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Keep the existing right-click menu and append only one native command.
        let menu = unsafe {
            environment.CreateContextMenuItem(
                w!("Add to Haven Walls review"),
                None::<&IStream>,
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
            )?
        };

        let app_for_selection = app.clone();
        let selected_handler = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
            let _ = app_for_selection.emit_to(
                "main",
                IMAGE_PICKED_EVENT,
                BrowserImagePicked {
                    image_url: image_url.clone(),
                    page_url: page_url.clone(),
                },
            );
            Ok(())
        }));
        let mut selected_token = 0i64;
        unsafe { menu.add_CustomItemSelected(&selected_handler, &mut selected_token)?; }

        let entries = unsafe { args.MenuItems()? };
        let mut count = 0u32;
        unsafe {
            entries.Count(&mut count)?;
            entries.InsertValueAtIndex(count, &menu)?;
        }
        Ok(())
    }));

    let mut context_token = 0i64;
    unsafe { webview11.add_ContextMenuRequested(&menu_handler, &mut context_token)?; }
    Ok(())
}
