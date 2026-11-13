//! Wikimedia Commons: on-demand preview search only.
//! Metadata is not proof that an image may be used in every context.
use std::time::Duration;
use serde::{Deserialize, Serialize};

const API: &str = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT: &str = "HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls; contact: GitHub issues)";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperCandidate {
    pub id: u64,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub thumbnail_url: String,
    pub page_url: String,
    pub license: String,
    pub license_url: Option<String>,
    pub source: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<WallpaperCandidate>,
    pub scanned: usize,
}
#[derive(Deserialize)]
struct ApiResponse {
    query: Option<ApiQuery>,
    error: Option<ApiError>,
}
#[derive(Deserialize)]
struct ApiError { info: String }
#[derive(Deserialize)]
struct ApiQuery { pages: Option<Vec<ApiPage>> }
#[derive(Deserialize)]
struct ApiPage {
    pageid: u64,
    title: String,
    imageinfo: Option<Vec<ImageInfo>>,
}
#[derive(Deserialize)]
struct ImageInfo {
    width: u32,
    height: u32,
    mime: Option<String>,
    thumburl: Option<String>,
    descriptionurl: Option<String>,
    extmetadata: Option<ExtendedMetadata>,
}
#[derive(Deserialize)]
struct ExtendedMetadata {
    #[serde(rename = "LicenseShortName")]
    license: Option<MetaField>,
    #[serde(rename = "LicenseUrl")]
    license_url: Option<MetaField>,
}
#[derive(Deserialize)]
struct MetaField { value: String }

fn is_supported_license(value: &str) -> bool {
    let name = value.trim().to_ascii_lowercase();
    matches!(name.as_str(), "cc0" | "cc by" | "cc by-sa" | "public domain")
        || name.starts_with("cc0 ")
        || name.starts_with("cc by ")
        || name.starts_with("cc by-sa ")
        || name.starts_with("public domain ")
}

fn extract_candidate(page: ApiPage) -> Option<WallpaperCandidate> {
    let image = page.imageinfo?.into_iter().next()?;
    if image.width < 1920 || image.height < 1080 || image.width <= image.height {
        return None;
    }
    if !matches!(image.mime.as_deref(), Some("image/jpeg" | "image/png" | "image/webp")) {
        return None;
    }
    let meta = image.extmetadata?;
    let license = meta.license?.value;
    if !is_supported_license(&license) { return None; }

    let thumbnail_url = image.thumburl?;
    if !thumbnail_url.starts_with("https://upload.wikimedia.org/wikipedia/commons/") {
        return None;
    }
    let page_url = image.descriptionurl?;
    if !page_url.starts_with("https://commons.wikimedia.org/wiki/File:") {
        return None;
    }
    let license_url = meta.license_url.map(|x| x.value)
        .filter(|url| url.starts_with("https://creativecommons.org/"));

    Some(WallpaperCandidate {
        id: page.pageid,
        title: page.title.trim_start_matches("File:").replace('_', " "),
        width: image.width,
        height: image.height,
        thumbnail_url,
        page_url,
        license,
        license_url,
        source: "Wikimedia Commons",
    })
}

fn parse_search_response(body: &str) -> Result<SearchResponse, String> {
    let data: ApiResponse = serde_json::from_str(body)
        .map_err(|_| "Unexpected response from Wikimedia Commons".to_string())?;
    if let Some(error) = data.error {
        return Err(format!("Wikimedia Commons: {}", error.info));
    }
    let pages = data.query.and_then(|q| q.pages).unwrap_or_default();
    let scanned = pages.len();
    let mut items: Vec<_> = pages.into_iter().filter_map(extract_candidate).collect();
    // Prefer 4K, followed by image area.
    items.sort_by_key(|item| (
        std::cmp::Reverse(item.width >= 3840 && item.height >= 2160),
        std::cmp::Reverse(u64::from(item.width) * u64::from(item.height)),
    ));
    items.truncate(24);
    Ok(SearchResponse { items, scanned })
}

#[tauri::command]
pub async fn search_commons_wallpapers(query: String) -> Result<SearchResponse, String> {
    let query = query.trim();
    if !(2..=70).contains(&query.chars().count()) {
        return Err("Search must be between 2 and 70 characters".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|_| "Could not initialize the search connection".to_string())?;

    let response = client.get(API).query(&[
        ("action", "query"),
        ("generator", "search"),
        ("gsrsearch", query),
        ("gsrnamespace", "6"),
        ("gsrlimit", "50"),
        ("prop", "imageinfo"),
        ("iiprop", "url|size|extmetadata|mime"),
        ("iiurlwidth", "640"),
        ("format", "json"),
        ("formatversion", "2"),
        ("maxlag", "5"),
    ]).send().await
      .map_err(|_| "Could not reach Wikimedia Commons. Check your connection.".to_string())?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
       || response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        return Err("Wikimedia Commons is busy or rate-limiting requests. Try again later.".into());
    }
    let response = response.error_for_status()
        .map_err(|_| "Wikimedia Commons returned an HTTP error".to_string())?;
    if response.content_length().is_some_and(|len| len > 3_000_000) {
        return Err("Wikimedia response was unexpectedly large".into());
    }
    let body = response.text().await
        .map_err(|_| "Could not read the Wikimedia response".to_string())?;
    if body.len() > 3_000_000 {
        return Err("Wikimedia response was unexpectedly large".into());
    }
    parse_search_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_license_labels() {
        assert!(is_supported_license("CC BY-SA 4.0"));
        assert!(is_supported_license("CC0"));
        assert!(is_supported_license("Public domain"));
        assert!(!is_supported_license("CC BY-NC 4.0"));
        assert!(!is_supported_license("All rights reserved"));
    }

    #[test]
    fn filters_bad_images_and_returns_attribution() {
        let json = r#"{"query":{"pages":[
         {"pageid":10,"title":"File:Lake.jpg","imageinfo":[{"width":4096,"height":2304,
          "mime":"image/jpeg",
          "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/lake.jpg/640px-lake.jpg",
          "descriptionurl":"https://commons.wikimedia.org/wiki/File:Lake.jpg",
          "extmetadata":{"LicenseShortName":{"value":"CC BY-SA 4.0"}}}]},
         {"pageid":11,"title":"File:Small.jpg","imageinfo":[{"width":800,"height":600,
          "mime":"image/jpeg",
          "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/small.jpg/640px-small.jpg",
          "descriptionurl":"https://commons.wikimedia.org/wiki/File:Small.jpg",
          "extmetadata":{"LicenseShortName":{"value":"CC0"}}}]}
        ]}}"#;
        let result = parse_search_response(json).unwrap();
        assert_eq!(result.scanned, 2);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Lake.jpg");
    }
}
