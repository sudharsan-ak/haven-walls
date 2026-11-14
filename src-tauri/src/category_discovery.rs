//! PR #4: user-initiated, public catalog searches (no background downloads).
//! Search metadata is never treated as verified image pixels or usage rights.
use crate::sources::{CatalogImage, CatalogResponse};
use reqwest::{Client, Url};
use serde_json::Value;
use std::time::Duration;

const MAX_RESPONSE: usize = 3_500_000;
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn n(v: &Value, key: &str) -> u32 {
    v.get(key).and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok()).unwrap_or(0)
}
fn valid_https(raw: &str) -> Option<String> {
    if raw.len() > 4096 { return None; }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https" || url.host_str().is_none() ||
        !url.username().is_empty() || url.password().is_some() { return None; }
    Some(url.to_string())
}
fn image(id: String, source: &str, title: &str, preview: String,
    original: Option<String>, page: String, credit: &str, rights: String,
    width: u32, height: u32) -> CatalogImage {
    CatalogImage {
        id, source: source.into(), title: title.chars().take(180).collect(),
        preview_url: preview, original_url: original, page_url: page,
        credit: credit.chars().take(200).collect(), rights, width, height,
        kind: "image".into(),
    }
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(22))
        .user_agent("HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls)")
        .build().map_err(|_| "Could not initialize discovery.".to_string())
}
async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Source rate limit reached. Try again later.".into());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Source denied the request. Check the API key and permissions.".into());
    }
    let response = response.error_for_status()
        .map_err(|_| format!("Image source returned HTTP {}.", status.as_u16()))?;
    if response.content_length().is_some_and(|length| length > MAX_RESPONSE as u64) {
        return Err("Image catalog was too large.".into());
    }
    let bytes = response.bytes().await.map_err(|_| "Could not read image catalog.".to_string())?;
    if bytes.len() > MAX_RESPONSE { return Err("Image catalog exceeded its size limit.".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "Image source returned invalid catalog data.".into())
}
async fn commons(client: &Client, query: &str, page: u32) -> Result<CatalogResponse, String> {
    let search = format!("{query} filetype:bitmap");
    let offset = ((page - 1) * 32).to_string();
    let response = client.get("https://commons.wikimedia.org/w/api.php")
        .query(&[
            ("action", "query"), ("generator", "search"), ("gsrsearch", search.as_str()),
            ("gsrnamespace", "6"), ("gsrlimit", "32"), ("gsroffset", offset.as_str()),
            ("prop", "imageinfo"),
            ("iiprop", "url|size|extmetadata"), ("iiurlwidth", "640"),
            ("format", "json"), ("formatversion", "2"),
        ])
        .send().await.map_err(|_| "Wikimedia Commons could not be reached.".to_string())?;
    let data = read_json(response).await?;
    let raw_count = data.pointer("/query/pages").and_then(Value::as_array)
        .map_or(0, Vec::len);
    // MediaWiki supplies gsroffset for the next search-results batch.
    let has_more = data.pointer("/continue/gsroffset").is_some() || raw_count == 32;
    let mut items = Vec::new();
    if let Some(pages) = data.pointer("/query/pages").and_then(Value::as_array) {
        for page in pages {
            let Some(info) = page.pointer("/imageinfo/0") else { continue; };
            let Some(original) = valid_https(s(info, "url")) else { continue; };
            let Ok(parsed) = Url::parse(&original) else { continue; };
            let path = parsed.path().to_ascii_lowercase();
            if ![".jpg", ".jpeg", ".png", ".webp"].iter().any(|ext| path.ends_with(ext)) {
                continue;
            }
            let preview = valid_https(s(info, "thumburl")).unwrap_or_else(|| original.clone());
            let Some(page_url) = valid_https(s(info, "descriptionurl")) else { continue; };
            let title = s(page, "title").trim_start_matches("File:").replace('_', " ");
            let id = page.get("pageid").and_then(Value::as_i64).unwrap_or_default();
            let license = info.pointer("/extmetadata/LicenseShortName/value")
                .and_then(Value::as_str).unwrap_or("Not verified");
            items.push(image(
                format!("commons-{id}"), "Wikimedia Commons", &title,
                preview, Some(original), page_url, "Wikimedia Commons contributor",
                format!("Check the individual Commons license and attribution requirements ({license})."),
                n(info, "width"), n(info, "height"),
            ));
        }
    }
    Ok(CatalogResponse {
        note: format!("{} Wikimedia Commons images. File sizes are provider-reported until verified.", items.len()),
        has_more: Some(has_more),
        items,
    })
}

async fn nasa_original(client: Client, id: String) -> Option<String> {
    let mut url = Url::parse("https://images-api.nasa.gov/asset/").ok()?;
    url.path_segments_mut().ok()?.push(&id);
    let data = read_json(client.get(url).send().await.ok()?).await.ok()?;
    let entries = data.pointer("/collection/items").and_then(Value::as_array)?;
    let mut best: Option<(u8, String)> = None;
    for entry in entries {
        let Some(href) = valid_https(s(entry, "href")) else { continue; };
        let Ok(parsed) = Url::parse(&href) else { continue; };
        let path = parsed.path().to_lowercase();
        if ![".jpg", ".jpeg", ".png", ".webp"].iter().any(|ext| path.ends_with(ext)) { continue; }
        let score = if path.contains("~orig.") { 4 }
            else if path.contains("~large.") { 3 }
            else if path.contains("~medium.") { 2 }
            else if path.contains("~thumb.") || path.contains("~small.") { 0 } else { 1 };
        if best.as_ref().is_none_or(|(previous, _)| score > *previous) {
            best = Some((score, href));
        }
    }
    best.map(|(_, url)| url)
}
async fn nasa(client: &Client, query: &str, page: u32) -> Result<CatalogResponse, String> {
    let page_param = page.to_string();
    let response = client.get("https://images-api.nasa.gov/search")
        .query(&[("q", query), ("media_type", "image"), ("page_size", "18"),
            ("page", page_param.as_str())])
        .send().await.map_err(|_| "NASA Image Library could not be reached.".to_string())?;
    let data = read_json(response).await?;
    let raw_count = data.pointer("/collection/items").and_then(Value::as_array)
        .map_or(0, Vec::len);
    let total = data.pointer("/collection/metadata/total_hits").and_then(Value::as_u64);
    let has_more = total.map_or(raw_count == 18, |hits| u64::from(page) * 18 < hits);
    let mut images: Vec<(CatalogImage, String)> = Vec::new();
    if let Some(results) = data.pointer("/collection/items").and_then(Value::as_array) {
        for entry in results.iter().take(18) {
            let Some(meta) = entry.pointer("/data/0") else { continue; };
            let id = s(meta, "nasa_id");
            if id.is_empty() || id.len() > 180 { continue; }
            let Some(preview) = valid_https(entry.pointer("/links/0/href")
                .and_then(Value::as_str).unwrap_or("")) else { continue; };
            let page = format!("https://images.nasa.gov/details/{}", id.replace(' ', "%20"));
            let title = if s(meta,"title").is_empty() { id } else { s(meta,"title") };
            images.push((image(
                format!("nasa-{id}"), "NASA Image Library", title, preview, None,
                page, s(meta,"center"), "Check the NASA item for image credits and usage guidelines.".into(),
                0, 0,
            ), id.into()));
        }
    }
    // NASA's search only provides thumbnails. Look up original asset links in
    // parallel; original pixel dimensions are still verified by Library.
    let mut requests = Vec::new();
    for (idx, (_, id)) in images.iter().enumerate() {
        let client = client.clone();
        let id = id.clone();
        requests.push((idx, tauri::async_runtime::spawn(async move {
            nasa_original(client, id).await
        })));
    }
    for (idx, request) in requests {
        if let Ok(Some(url)) = request.await { images[idx].0.original_url = Some(url); }
    }
    let items: Vec<CatalogImage> = images.into_iter().map(|(item, _)| item).collect();
    Ok(CatalogResponse {
        note: format!("{} NASA images. Original links are resolved from NASA asset manifests.", items.len()),
        has_more: Some(has_more),
        items,
    })
}
async fn unsplash(client: &Client, query: &str, api_key: &str, page: u32) -> Result<CatalogResponse, String> {
    let key = api_key.trim();
    if key.is_empty() { return Err("Enter an Unsplash access key to enable this source.".into()); }
    if key.len() > 256 || key.chars().any(char::is_whitespace) {
        return Err("Invalid Unsplash access key.".into());
    }
    let page_param = page.to_string();
    let response = client.get("https://api.unsplash.com/search/photos")
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .query(&[("query", query), ("per_page", "24"), ("page", page_param.as_str()),
            ("orientation", "landscape"), ("content_filter", "high")])
        .send().await.map_err(|_| "Unsplash search could not be reached.".to_string())?;
    let data = read_json(response).await?;
    let raw_count = data.get("results").and_then(Value::as_array).map_or(0, Vec::len);
    let has_more = data.get("total_pages").and_then(Value::as_u64)
        .map_or(raw_count == 24, |total| u64::from(page) < total);
    let mut items = Vec::new();
    if let Some(results) = data.get("results").and_then(Value::as_array) {
        for entry in results {
            let Some(preview) = valid_https(entry.pointer("/urls/small")
                .and_then(Value::as_str).unwrap_or("")) else { continue; };
            let original = valid_https(entry.pointer("/urls/raw")
                .and_then(Value::as_str).unwrap_or(""));
            let Some(page) = valid_https(entry.pointer("/links/html")
                .and_then(Value::as_str).unwrap_or("")) else { continue; };
            let title = ["alt_description", "description"].iter().map(|k| s(entry,k))
                .find(|s| !s.trim().is_empty()).unwrap_or("Unsplash photograph");
            let credit = entry.pointer("/user/name").and_then(Value::as_str)
                .unwrap_or("Unsplash photographer");
            let id = s(entry, "id");
            if id.is_empty() { continue; }
            items.push(image(
                format!("unsplash-{id}"), "Unsplash", title,
                preview, original, page, credit,
                format!("Photo by {credit} on Unsplash. Check its license and attribution requirements."),
                n(entry,"width"), n(entry,"height"),
            ));
        }
    }
    Ok(CatalogResponse {
        note: format!("{} Unsplash photographs. API use requires an authorized key and compliance with provider terms.", items.len()),
        has_more: Some(has_more),
        items,
    })
}

/// This command is only called after a user selects a topic or presses Refresh.
#[tauri::command]
pub async fn browse_category_images(
    provider: String, query: String, unsplash_key: String, page: Option<u32>,
) -> Result<CatalogResponse, String> {
    let page = page.unwrap_or(1);
    if !(1..=100).contains(&page) {
        return Err("Only pages 1 through 100 are supported.".into());
    }
    let query = query.trim();
    if !(2..=100).contains(&query.chars().count()) || query.chars().any(|ch| ch.is_control()) {
        return Err("Enter a category query between 2 and 100 ordinary characters.".into());
    }
    let client = client()?;
    match provider.as_str() {
        "commons" => commons(&client, query, page).await,
        "nasa" => nasa(&client, query, page).await,
        "unsplash" => unsplash(&client, query, &unsplash_key, page).await,
        _ => Err("Unsupported category source.".into()),
    }
}
