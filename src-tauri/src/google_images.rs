//! Google Images discovery through SerpApi's documented Google Images API.
//! Explicit user search only. We use metadata to filter candidates and never
//! fetch or cache original files in the Rust backend.
use crate::sources::{CatalogImage, CatalogResponse};
use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const API: &str = "https://serpapi.com/search.json";
const MAX_BYTES: usize = 4_000_000;

fn field<'a>(item: &'a Value, name: &str) -> &'a str {
    item.get(name).and_then(Value::as_str).unwrap_or("")
}

fn https_only(url: &str) -> Option<&str> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() == "https"
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
    {
        Some(url)
    } else {
        None
    }
}

/// Metadata filtering is not image decoding or license verification.
fn parse_images(data: &Value, min_width: u32, min_height: u32) -> Result<CatalogResponse, String> {
    if data.get("error").and_then(Value::as_str).is_some() {
        return Err("Google Images search was rejected. Check the SerpApi key and available credits.".into());
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some(images) = data.get("images_results").and_then(Value::as_array) {
        for (position, item) in images.iter().enumerate() {
            if item.get("is_product").and_then(Value::as_bool) == Some(true)
                || item.get("unsafe").and_then(Value::as_bool) == Some(true)
            {
                continue;
            }

            let width = item
                .get("original_width")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_default();
            let height = item
                .get("original_height")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or_default();
            if width < min_width || height < min_height {
                continue;
            }
            // Keep desktop landscape imagery, excluding square, portrait and
            // unusually thin banners. Multi-monitor panoramic support comes later.
            let ratio = f64::from(width) / f64::from(height);
            if !(1.45..=2.6).contains(&ratio) {
                continue;
            }

            let Some(original) = https_only(field(item, "original")) else {
                continue;
            };
            let Some(thumbnail) = https_only(field(item, "thumbnail")) else {
                continue;
            };
            let Some(page) = https_only(field(item, "link")) else {
                continue;
            };

            // Exact URL duplicate detection. Perceptual duplicate detection is
            // a separate library milestone, not claimed here.
            let dedupe = original.split('?').next().unwrap_or(original).to_lowercase();
            if !seen.insert(dedupe) {
                continue;
            }

            let title = field(item, "title").trim();
            let source = field(item, "source").trim();
            let result = CatalogImage {
                id: format!("google-{}", position + 1),
                source: "Google Images (SerpApi)".into(),
                title: if title.is_empty() {
                    format!("Image from {}", if source.is_empty() { "the web" } else { source })
                } else {
                    title.chars().take(180).collect()
                },
                preview_url: thumbnail.to_string(),
                page_url: page.to_string(),
                credit: if source.is_empty() { "Source page".into() } else { source.to_string() },
                rights: "Discovered via Google Images. Copyright and permission are NOT verified; check the original source.".into(),
                width,
                height,
                kind: "image".into(),
            };
            // Prefer true 4K imagery, then images closest to 16:9,
            // then search engine order for ties.
            let is_4k = width >= 3840 && height >= 2160;
            let ratio_penalty = (ratio - 16.0 / 9.0).abs();
            candidates.push((result, is_4k, ratio_penalty, position));
        }
    }
    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.2.total_cmp(&b.2))
            .then_with(|| a.3.cmp(&b.3))
    });

    let count = candidates.len();
    let items = candidates
        .into_iter()
        .take(36)
        .map(|(image, _, _, _)| image)
        .collect();

    Ok(CatalogResponse {
        items,
        note: format!(
            "{count} candidates passed metadata filters. Results are from Google Images via SerpApi. \
            Resolution is provider-reported, not independently measured. Verify actual quality, \
            copyright and usage permission on the original site before any download."
        ),
    })
}

#[tauri::command]
pub async fn browse_google_images(
    query: String,
    serpapi_key: String,
    min_width: u32,
    min_height: u32,
) -> Result<CatalogResponse, String> {
    let query = query.trim();
    if !(2..=100).contains(&query.chars().count()) {
        return Err("Enter a search query between 2 and 100 characters.".into());
    }
    let key = serpapi_key.trim();
    if key.is_empty() {
        return Err("Enter your SerpApi API key to search Google Images inside Haven Walls.".into());
    }
    if !matches!(
        (min_width, min_height),
        (1920, 1080) | (2560, 1440) | (3840, 2160)
    ) {
        return Err("Unsupported image resolution filter.".into());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls)")
        .build()
        .map_err(|_| "Couldn't initialize Google Images search.".to_string())?;

    // This credential is passed over HTTPS directly from Rust to SerpApi,
    // and is never written to Haven Walls' settings, logs, or disk.
    let response = client
        .get(API)
        .query(&[
            ("engine", "google_images"),
            ("q", query),
            ("imgsz", "2mp"),
            ("imgar", "w"),
            ("safe", "active"),
            ("hl", "en"),
            ("gl", "us"),
            ("api_key", key),
        ])
        .send()
        .await
        .map_err(|_| "Couldn't contact SerpApi. Check your network connection.".to_string())?;

    match response.status() {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            return Err("SerpApi denied the request. Check your API key.".into());
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            return Err("SerpApi search credits or rate limit reached. Try later.".into());
        }
        _ => {}
    }
    let response = response
        .error_for_status()
        .map_err(|_| "SerpApi returned a search error.".to_string())?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err("Image search response is too large.".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Couldn't read SerpApi image results.".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Image search response is too large.".into());
    }
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Unexpected image search response.".to_string())?;
    parse_images(&data, min_width, min_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_portrait_small_unsafe_and_duplicate_images() {
        let data = serde_json::json!({"images_results": [
            {"title":"A", "original":"https://images.example/a.jpg", "thumbnail":"https://serpapi.com/a.png", "link":"https://example.com/a", "original_width":4096, "original_height":2304, "source":"example"},
            {"title":"A duplicate", "original":"https://images.example/a.jpg?foo=1", "thumbnail":"https://serpapi.com/a.png", "link":"https://example.com/a", "original_width":4096, "original_height":2304},
            {"title":"Portrait", "original":"https://images.example/b.jpg", "thumbnail":"https://serpapi.com/b.png", "link":"https://example.com/b", "original_width":1080, "original_height":1920},
            {"title":"Unsafe", "original":"https://images.example/c.jpg", "thumbnail":"https://serpapi.com/c.png", "link":"https://example.com/c", "original_width":3840, "original_height":2160, "unsafe":true},
            {"title":"Too small", "original":"https://images.example/d.jpg", "thumbnail":"https://serpapi.com/d.png", "link":"https://example.com/d", "original_width":1024, "original_height":768}
        ]});
        let response = parse_images(&data, 1920, 1080).unwrap();
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].title, "A");
    }

    #[test]
    fn rejects_non_https_image_links() {
        let data = serde_json::json!({"images_results":[{
            "title":"Unsafe URL",
            "original":"http://images.example/a.jpg",
            "thumbnail":"https://serpapi.com/a.png",
            "link":"https://example.com/a",
            "original_width":3840,
            "original_height":2160
        }]});
        let response = parse_images(&data, 1920, 1080).unwrap();
        assert!(response.items.is_empty());
    }
}
