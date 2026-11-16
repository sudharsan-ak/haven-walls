//! Browser Review selection persistence (PR #6 Commit 1).
//! Only explicit HTTPS image links and descriptive metadata are stored.
//! No downloads or modifications to the managed wallpaper Library occur here.
use std::collections::HashSet;
use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{browser_storage, local_storage::StorageLock};

const MAX_REVIEW_ITEMS: usize = 30;
const MAX_CANDIDATES: usize = 12;
const MAX_SERIALIZED_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReviewImage {
    id: String,
    source: String,
    title: String,
    preview_url: String,
    #[serde(default)]
    original_url: Option<String>,
    #[serde(default)]
    candidate_urls: Vec<String>,
    page_url: String,
    credit: String,
    rights: String,
    width: u32,
    height: u32,
    kind: String,
}

/// A Review entry is a selected *remote image*, never a local path, an
/// embedded data URL, or a link to an internal/private network endpoint.
/// The Library importer performs its own independent validation at save time.
fn public_https(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 4096 { return false; }
    let Ok(url) = tauri::Url::parse(raw) else { return false; };
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false; };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if !host.contains('.')
        || host == "localhost"
        || host == "0.0.0.0"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.parse::<IpAddr>().is_ok()
    {
        return false;
    }
    true
}

fn valid_review(images: &[SavedReviewImage]) -> Result<(), String> {
    if images.len() > MAX_REVIEW_ITEMS {
        return Err("Review can contain at most 30 images.".into());
    }
    let mut seen = HashSet::new();
    for image in images {
        if image.kind != "image" || image.id.is_empty() || image.id.len() > 4250
            || image.source.is_empty() || image.source.len() > 140
            || image.title.is_empty() || image.title.len() > 200
            || image.credit.len() > 600 || image.rights.len() > 1000
            || image.width > 20000 || image.height > 20000
            || !public_https(&image.preview_url)
            || image.original_url.as_deref().is_some_and(|url| !public_https(url))
            || (!image.page_url.is_empty() && !public_https(&image.page_url))
            || image.candidate_urls.len() > MAX_CANDIDATES
            || image.candidate_urls.iter().any(|url| !public_https(url))
        {
            return Err("Review contains an invalid image URL or metadata.".into());
        }
        let dedupe = image.original_url.as_deref().unwrap_or(&image.preview_url);
        if !seen.insert(dedupe.to_string()) {
            return Err("Review contains the same image more than once.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_load_review(
    app: AppHandle,
    state: State<'_, StorageLock>,
) -> Result<Vec<SavedReviewImage>, String> {
    let _guard = state.0.lock()
        .map_err(|_| "Review storage is unavailable.".to_string())?;
    let conn = browser_storage::database(&app)?;
    let existing: Option<String> = conn.query_row(
        "SELECT json FROM browser_review WHERE id=1", [],
        |row| row.get(0),
    ).optional().map_err(|_| "Could not read saved Review images.".to_string())?;
    match existing {
        None => Ok(Vec::new()),
        Some(json) => {
            if json.len() > MAX_SERIALIZED_BYTES {
                return Err("Saved Review exceeds the supported size.".into());
            }
            let images: Vec<SavedReviewImage> = serde_json::from_str(&json)
                .map_err(|_| "Saved Review data could not be decoded.".to_string())?;
            valid_review(&images)?;
            Ok(images)
        }
    }
}

#[tauri::command]
pub fn browser_save_review(
    app: AppHandle,
    state: State<'_, StorageLock>,
    images: Vec<SavedReviewImage>,
) -> Result<(), String> {
    valid_review(&images)?;
    let json = serde_json::to_string(&images)
        .map_err(|_| "Could not encode the Review selection.".to_string())?;
    if json.len() > MAX_SERIALIZED_BYTES {
        return Err("Review metadata exceeds the 1 MB storage limit.".into());
    }
    let _guard = state.0.lock()
        .map_err(|_| "Review storage is unavailable.".to_string())?;
    let conn = browser_storage::database(&app)?;
    conn.execute(
        "INSERT INTO browser_review(id,json) VALUES(1,?1)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![json],
    ).map_err(|_| "Could not persist the Review selection.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_image(url: &str) -> SavedReviewImage {
        SavedReviewImage {
            id: format!("browser-{url}"),
            source: "Haven Walls Browser".into(),
            title: "Mountain photograph".into(),
            preview_url: url.into(),
            original_url: None,
            candidate_urls: vec![],
            page_url: "https://example.com/photo".into(),
            credit: "Photographer unverified".into(),
            rights: "Rights unverified".into(),
            width: 1920,
            height: 1080,
            kind: "image".into(),
        }
    }

    #[test]
    fn accepts_remote_image_metadata_and_empty_review() {
        assert!(valid_review(&[]).is_ok());
        let images = vec![sample_image("https://images.unsplash.com/photo-123")];
        assert!(valid_review(&images).is_ok());
        let encoded = serde_json::to_string(&images).expect("serialize");
        let restored: Vec<SavedReviewImage> =
            serde_json::from_str(&encoded).expect("deserialize");
        assert!(valid_review(&restored).is_ok());
        assert_eq!(restored[0].title, images[0].title);
    }

    #[test]
    fn rejects_internal_and_local_urls() {
        for url in [
            "about:blank", "file:///C:/Windows/system.ini",
            "http://example.com/image.png", "https://localhost/image.png",
            "https://127.0.0.1/image.png", "https://printer.local/image.jpg",
        ] {
            assert!(!public_https(url), "accepted prohibited URL: {url}");
        }
        assert!(public_https("https://images.pexels.com/photos/123/image.jpeg"));
    }

    #[test]
    fn rejects_duplicate_and_excess_images() {
        let image = sample_image("https://images.unsplash.com/photo-123");
        assert!(valid_review(&[image.clone(), image.clone()]).is_err());
        assert!(valid_review(&vec![image; 31]).is_err());
    }

    #[test]
    fn rejects_missing_or_invalid_source_and_candidates() {
        let mut image = sample_image("https://images.unsplash.com/photo-123");
        image.original_url = Some("file:///C:/secret.jpg".into());
        assert!(valid_review(&[image.clone()]).is_err());
        image.original_url = None;
        image.candidate_urls = vec!["https://127.0.0.1/private".into()];
        assert!(valid_review(&[image]).is_err());
    }
}
