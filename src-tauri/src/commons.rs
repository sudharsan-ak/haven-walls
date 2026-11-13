//! Wikimedia Commons on-demand preview search.
//! File metadata is not proof that wallpaper use is permitted.
use serde::{Deserialize, Serialize};
use std::time::Duration;

const API: &str = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT: &str =
    "HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls; contact: GitHub issues)";
const MIN_WIDTH: u32 = 1920;
const MIN_HEIGHT: u32 = 1080;

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
struct ApiError {
    info: String,
}

#[derive(Deserialize)]
struct ApiQuery {
    pages: Option<Vec<ApiPage>>,
}

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
struct MetaField {
    value: String,
}

fn is_supported_license(value: &str) -> bool {
    let name = value.trim().to_ascii_lowercase();
    matches!(
        name.as_str(),
        "cc0" | "cc by" | "cc by-sa" | "public domain"
    ) || name.starts_with("cc0 ")
        || name.starts_with("cc by ")
        || name.starts_with("cc by-sa ")
        || name.starts_with("public domain ")
}

fn extract_candidate(page: ApiPage) -> Option<WallpaperCandidate> {
    let image = page.imageinfo?.into_iter().next()?;
    if image.width < MIN_WIDTH || image.height < MIN_HEIGHT || image.width <= image.height {
        return None;
    }
    if !matches!(
        image.mime.as_deref(),
        Some("image/jpeg" | "image/png" | "image/webp")
    ) {
        return None;
    }

    // A missing license is allowed for on-screen preview ONLY.
    // PR #3 must refuse downloading/applying until rights have been verified.
    let license = image
        .extmetadata
        .as_ref()
        .and_then(|meta| meta.license.as_ref())
        .map(|item| item.value.trim())
        .filter(|value| !value.is_empty());

    let license = match license {
        Some(name) if is_supported_license(name) => name.to_string(),
        Some(_) => return None,
        None => "License needs verification".to_string(),
    };

    let thumbnail_url = image.thumburl?;
    if !thumbnail_url.starts_with("https://upload.wikimedia.org/wikipedia/commons/") {
        return None;
    }

    let page_url = image.descriptionurl?;
    if !page_url.starts_with("https://commons.wikimedia.org/wiki/File:") {
        return None;
    }

    let license_url = image
        .extmetadata
        .and_then(|meta| meta.license_url)
        .map(|field| field.value)
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

    let pages = data.query.and_then(|query| query.pages).unwrap_or_default();
    let scanned = pages.len();
    let mut items: Vec<_> = pages.into_iter().filter_map(extract_candidate).collect();
    // Favor 4K photos, then higher resolutions.
    items.sort_by_key(|image| {
        (
            std::cmp::Reverse(image.width >= 3840 && image.height >= 2160),
            std::cmp::Reverse(u64::from(image.width) * u64::from(image.height)),
        )
    });
    items.truncate(24);

    Ok(SearchResponse { items, scanned })
}

async fn search_batch(
    client: &reqwest::Client,
    subject: &str,
) -> Result<SearchResponse, String> {
    // Filter on the Commons search server BEFORE requesting expensive image metadata.
    // These operators are documented by MediaWiki's CirrusSearch.
    let search = format!(
        "{} filetype:bitmap filew:>1919 fileh:>1079",
        subject.trim()
    );

    let response = client
        .get(API)
        .query(&[
            ("action", "query"),
            ("generator", "search"),
            ("gsrsearch", search.as_str()),
            ("gsrnamespace", "6"),
            ("gsrlimit", "30"),
            ("prop", "imageinfo"),
            ("iiprop", "url|size|extmetadata|mime"),
            ("iiextmetadatafilter", "LicenseShortName|LicenseUrl"),
            ("iiurlwidth", "640"),
            ("format", "json"),
            ("formatversion", "2"),
            ("maxlag", "5"),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach Wikimedia Commons. Check your connection.".to_string())?;

    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        || response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE
    {
        return Err("Wikimedia Commons is busy or rate-limiting requests. Try again later.".into());
    }

    let response = response
        .error_for_status()
        .map_err(|_| "Wikimedia Commons returned an HTTP error".to_string())?;

    if response.content_length().is_some_and(|len| len > 3_000_000) {
        return Err("Wikimedia response was unexpectedly large".into());
    }

    let body = response
        .text()
        .await
        .map_err(|_| "Could not read the Wikimedia response".to_string())?;
    if body.len() > 3_000_000 {
        return Err("Wikimedia response was unexpectedly large".into());
    }

    parse_search_response(&body)
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

    let first = search_batch(&client, query).await?;
    if !first.items.is_empty() || query.split_whitespace().count() > 1 {
        return Ok(first);
    }

    // A single place or subject may rank maps and flags ahead of photographs.
    // Retry ONCE using a more image-oriented query. No background polling.
    let mut second = search_batch(&client, &format!("{query} landscape")).await?;
    second.scanned += first.scanned;
    Ok(second)
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
    fn filters_images_but_keeps_verified_license_metadata() {
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
        assert_eq!(result.items[0].license, "CC BY-SA 4.0");
    }

    #[test]
    fn missing_license_is_preview_only_and_explicit_restrictions_are_excluded() {
        let json = r#"{"query":{"pages":[
         {"pageid":15,"title":"File:Unknown.jpg","imageinfo":[{"width":3000,"height":2000,
          "mime":"image/jpeg",
          "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/test.jpg/640px-test.jpg",
          "descriptionurl":"https://commons.wikimedia.org/wiki/File:Unknown.jpg"}]},
         {"pageid":16,"title":"File:Restricted.jpg","imageinfo":[{"width":3000,"height":2000,
          "mime":"image/jpeg",
          "thumburl":"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/restricted.jpg/640px-restricted.jpg",
          "descriptionurl":"https://commons.wikimedia.org/wiki/File:Restricted.jpg",
          "extmetadata":{"LicenseShortName":{"value":"All rights reserved"}}}]}
        ]}}"#;

        let result = parse_search_response(json).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].license, "License needs verification");
    }
}
