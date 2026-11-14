//! Best-available, *user-initiated* source resolution.
//! Only explicitly selected image URLs and a bounded set of image metadata URLs
//! from the recorded original page are considered. Never scrape Google search.
use super::*;
use base64::Engine as _;
use std::time::{Duration, Instant};

const MAX_CANDIDATES: usize = 12;
const MAX_SITE_IMAGES: usize = 4;
const MAX_HTML_BYTES: usize = 384 * 1024;
const TOTAL_PROBE_TIME: Duration = Duration::from_secs(48);

struct Probe {
    url: String,
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    fingerprint: u64,
}

async fn fetch_public_bytes(
    url_str: &str,
    max_bytes: usize,
    expect_html: bool,
) -> Result<Vec<u8>, String> {
    let mut current = url_str.to_string();
    // Redirects are handled manually; every hop gets new SSRF/DNS validation.
    for redirect in 0..=2 {
        let (url, addresses) = secure_url(&current)?;
        let host = url.host_str().ok_or("Missing public HTTPS hostname")?.to_string();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(&host, &addresses)
            .timeout(Duration::from_secs(11))
            .user_agent("HavenWalls/0.1 (user-approved original image lookup)")
            .build().map_err(|e| format!("Could not prepare HTTPS request: {e}"))?;
        let mut response = client.get(url.clone()).send().await
            .map_err(|e| format!("Source request failed: {e}"))?;
        if response.status().is_redirection() {
            if redirect == 2 { return Err("Image source redirected too many times.".into()); }
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("The image source redirected without a usable address.")?;
            let next = url.join(location)
                .map_err(|_| "Image source redirect is invalid.".to_string())?;
            secure_url(next.as_str())?;
            current = next.to_string();
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Source returned HTTP {}.", response.status()));
        }
        if !expect_html && response.content_length().unwrap_or_default() > max_bytes as u64 {
            return Err("Source exceeds the allowed response size.".into());
        }
        if let Some(value) = response.headers().get(reqwest::header::CONTENT_TYPE) {
            let mime = value.to_str().unwrap_or("").to_ascii_lowercase();
            let accepted = if expect_html {
                mime.starts_with("text/html") || mime.starts_with("application/xhtml+xml")
            } else {
                mime.starts_with("image/") || mime.starts_with("application/octet-stream")
            };
            if !accepted {
                return Err(if expect_html {
                    "Original page did not return HTML.".into()
                } else {
                    "Source returned a webpage or a non-image response.".into()
                });
            }
        }
        let mut bytes = Vec::with_capacity(
            response.content_length().unwrap_or(0).min(max_bytes as u64) as usize
        );
        while let Some(chunk) = response.chunk().await
            .map_err(|e| format!("Source transfer interrupted: {e}"))? {
            if expect_html {
                // Source websites can return large HTML documents. Only read
                // their bounded initial metadata region; do not reject a
                // useful image OG tag because the full page is over 384 KB.
                let remaining = max_bytes.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                if bytes.len() >= max_bytes { break; }
            } else {
                if bytes.len().saturating_add(chunk.len()) > max_bytes {
                    return Err("Source response exceeded the safety limit.".into());
                }
                bytes.extend_from_slice(&chunk);
            }
        }
        if bytes.is_empty() { return Err("Source returned an empty file.".into()); }
        return Ok(bytes);
    }
    Err("Source could not be retrieved.".into())
}

fn tag_attribute(tag: &str, wanted: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut i = 1usize;
    // Skip element name.
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() { i += 1; }
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() || bytes[i] == b'>' || bytes[i] == b'/' { break; }
        let start = i;
        while i < bytes.len() &&
            (bytes[i].is_ascii_alphanumeric() || b"-_:".contains(&bytes[i])) { i += 1; }
        if i == start { i += 1; continue; }
        let name = &tag[start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() || bytes[i] != b'=' { continue; }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() { break; }
        let value;
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != quote { i += 1; }
            value = &tag[start..i];
            i = (i + 1).min(bytes.len());
        } else {
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() &&
                bytes[i] != b'>' { i += 1; }
            value = &tag[start..i];
        }
        if name.eq_ignore_ascii_case(wanted) {
            return Some(value.to_string());
        }
    }
    None
}

fn html_entities(text: &str) -> String {
    // Attribute URLs commonly use &amp;. Never interpret script or markup.
    text.replace("&amp;", "&").replace("&#38;", "&")
        .replace("&quot;", "\"").replace("&#34;", "\"")
        .replace("&#39;", "'").replace("&apos;", "'")
}

fn largest_srcset_url(value: &str) -> Option<String> {
    let mut best: Option<(u32, String)> = None;
    for entry in value.split(',').take(18) {
        let mut parts = entry.split_ascii_whitespace();
        let Some(url) = parts.next() else { continue };
        if url.len() > 4096 { continue; }
        let size = parts.next().and_then(|descriptor| {
            descriptor.strip_suffix('w')
                .and_then(|value| value.parse::<u32>().ok())
        }).unwrap_or(0);
        if best.as_ref().is_none_or(|(current, _)| size > *current) {
            best = Some((size, url.to_string()));
        }
    }
    best.map(|(_, value)| value)
}

fn image_metadata_links(page_url: &str, html: &[u8]) -> Vec<String> {
    let Ok(base) = reqwest::Url::parse(page_url) else { return Vec::new(); };
    let source = String::from_utf8_lossy(html);
    let lower = source.to_ascii_lowercase();
    let mut results = Vec::new();
    let mut offset = 0usize;
    // Extract only standard image metadata, not arbitrary webpage images.
    // This prevents replacing the selected picture with an unrelated gallery item.
    while offset < lower.len() && results.len() < MAX_SITE_IMAGES {
        let meta = lower[offset..].find("<meta").map(|x| (offset + x, true));
        let link = lower[offset..].find("<link").map(|x| (offset + x, false));
        let next = match (meta, link) {
            (Some(a), Some(b)) => if a.0 < b.0 { a } else { b },
            (Some(a), None) => a,
            (None, Some(b)) => b,
            _ => break,
        };
        let start = next.0;
        let Some(end_offset) = lower[start..].find('>') else { break; };
        let end = start + end_offset + 1;
        if end - start > 4096 { offset = end; continue; }
        let tag = &source[start..end];
        let candidate = if next.1 {
            let key = tag_attribute(tag, "property")
                .or_else(|| tag_attribute(tag, "name"))
                .unwrap_or_default().to_ascii_lowercase();
            if matches!(key.as_str(),
                "og:image" | "og:image:url" | "og:image:secure_url" |
                "twitter:image" | "twitter:image:src") {
                tag_attribute(tag, "content")
            } else { None }
        } else {
            let rel = tag_attribute(tag, "rel")
                .unwrap_or_default().to_ascii_lowercase();
            if rel.split_ascii_whitespace().any(|r| r == "image_src") {
                tag_attribute(tag, "href")
            } else if rel.split_ascii_whitespace().any(|r| r == "preload") &&
                tag_attribute(tag, "as").unwrap_or_default().eq_ignore_ascii_case("image") {
                tag_attribute(tag, "imagesrcset")
                    .and_then(|value| largest_srcset_url(&value))
                    .or_else(|| tag_attribute(tag, "href"))
            } else { None }
        };
        if let Some(raw) = candidate {
            let raw = html_entities(&raw);
            if let Ok(url) = base.join(&raw) {
                let url_string = url.to_string();
                if url.scheme() == "https" && url_string.len() <= 4096 &&
                    !results.contains(&url_string) {
                    results.push(url_string);
                }
            }
        }
        offset = end;
    }
    results
}

fn is_google_search_page(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "google.com" || host.ends_with(".google.com") ||
        host.ends_with(".gstatic.com") || host.ends_with(".googleusercontent.com")
}

async fn probe(url: String) -> Result<Probe, String> {
    let bytes = fetch_public_bytes(&url, MAX_IMAGE_BYTES, false).await?;
    // Image decoding can be expensive and must not block async IO threads.
    tauri::async_runtime::spawn_blocking(move || {
        let (image, _) = image_format(&bytes)?;
        let (width, height) = image.dimensions();
        let fingerprint = perceptual_hash(&image);
        Ok::<Probe, String>(Probe { url, bytes, width, height, fingerprint })
    }).await.map_err(|_| "Image inspection task was interrupted.".to_string())?
}

fn related_picture(candidate: &Probe, reference: &Probe) -> bool {
    // The original site may use a different crop or compression, but do not
    // silently save an unrelated OG cover or logo as this wallpaper.
    let ratio_a = candidate.width as f64 / candidate.height.max(1) as f64;
    let ratio_b = reference.width as f64 / reference.height.max(1) as f64;
    (ratio_a / ratio_b >= 0.72 && ratio_a / ratio_b <= 1.38) &&
        (candidate.fingerprint ^ reference.fingerprint).count_ones() <= 17
}

/// Resolve an explicitly selected image without writing any Library file.
async fn find_best_source(
    candidate_urls: Vec<String>,
    source_page: String,
) -> Result<(Probe, usize), String> {
    if candidate_urls.is_empty() || candidate_urls.len() > MAX_CANDIDATES {
        return Err("Select 1–12 candidate URLs for this image.".into());
    }
    let mut urls = Vec::new();
    for value in candidate_urls {
        let (parsed, _) = secure_url(&value)?;
        let canonical = parsed.to_string();
        if !urls.contains(&canonical) { urls.push(canonical); }
    }
    // The original source page is inspected only for standard public metadata
    // supplied with this specific user-selected image. Never scrape Google.
    let page = source_page.trim().to_string();
    let mut site_candidates = Vec::new();
    if !page.is_empty() && !is_google_search_page(&page) &&
        secure_url(&page).is_ok() {
        if let Ok(html) = fetch_public_bytes(&page, MAX_HTML_BYTES, true).await {
            site_candidates = image_metadata_links(&page, &html);
        }
    }
    let start = Instant::now();
    let mut best: Option<Probe> = None;
    let mut reference_hash: Option<(u64, f64)> = None;
    let mut tried = 0usize;
    let mut last_error = String::new();
    for (url, from_page) in urls.into_iter().map(|u| (u, false))
        .chain(site_candidates.into_iter().map(|u| (u, true))) {
        if tried >= MAX_CANDIDATES || start.elapsed() >= TOTAL_PROBE_TIME { break; }
        if from_page && best.is_none() { continue; }
        if from_page && secure_url(&url).is_err() { continue; }
        tried += 1;
        match probe(url).await {
            Ok(candidate) => {
                if from_page {
                    if let Some(ref baseline) = best {
                        if !related_picture(&candidate, baseline) {
                            continue;
                        }
                    }
                } else if reference_hash.is_none() {
                    reference_hash = Some((
                        candidate.fingerprint,
                        candidate.width as f64 / candidate.height.max(1) as f64,
                    ));
                } else if let Some((hash, ratio)) = reference_hash {
                    let candidate_ratio = candidate.width as f64 / candidate.height.max(1) as f64;
                    // Explicit URLs may point to thumbnails or source variants,
                    // but avoid incorrectly combining unrelated images.
                    if (candidate_ratio / ratio < 0.65 || candidate_ratio / ratio > 1.55) ||
                        (hash ^ candidate.fingerprint).count_ones() > 22 {
                        continue;
                    }
                }
                let better = best.as_ref().map(|existing|
                    u64::from(candidate.width) * u64::from(candidate.height) >
                    u64::from(existing.width) * u64::from(existing.height)
                ).unwrap_or(true);
                if better { best = Some(candidate); }
            },
            Err(error) => { last_error = error; }
        }
    }
    let Some(best) = best else {
        return Err(format!(
            "No valid original image could be retrieved from the selected links. {last_error} \
             Open the source website and copy its full-size image URL to import manually."
        ));
    };
    Ok((best, tried))
}

#[tauri::command]
pub async fn import_best_wallpaper_urls(
    app: AppHandle,
    candidate_urls: Vec<String>,
    mut metadata: ImportMetadata,
) -> Result<ImportOutcome, String> {
    metadata.clean()?;
    let (best, tried) = find_best_source(candidate_urls, metadata.source_page.clone()).await?;
    let (w,h) = (best.width, best.height);
    metadata.original_url = best.url;
    // The existing importer applies user settings and writes only this
    // verified winning image. It never saves a smaller probe first.
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageLock>();
        import_bytes(&app, &state, best.bytes, metadata, true)
    }).await.map_err(|_| "Wallpaper import task was interrupted.".to_string())?
      .map_err(|error| format!(
        "Checked {tried} source version(s); best accessible image was {w} × {h}.          {error} If the source website offers a larger original, paste that direct image URL."
      ))?;
    result.note = format!(
        "{} Checked {} available source version(s) and chose {} × {} pixels. \
         Resolution reflects decoded pixels, not a guarantee of optical sharpness.",
        result.note, tried, w, h,
    );
    Ok(result)
}


/// The native inspector verifies the original source and returns a bounded
/// preview. The image shown in the UI can be 1600px wide while its verified
/// *downloaded source* remains 4K or 8K. Do not conflate those dimensions.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedOriginal {
    pub original_url: String,
    pub width: u32,
    pub height: u32,
    pub preview_data_url: String,
    pub preview_width: u32,
    pub preview_height: u32,
    pub tried: usize,
}

#[tauri::command]
pub async fn inspect_best_wallpaper_urls(
    candidate_urls: Vec<String>,
    source_page: String,
) -> Result<InspectedOriginal, String> {
    if source_page.len() > 4096 {
        return Err("Image source page address is too long.".into());
    }
    let (best, tried) = find_best_source(candidate_urls, source_page).await?;
    let original_url = best.url;
    let (width, height) = (best.width, best.height);
    let (preview_data_url, preview_width, preview_height) =
        tauri::async_runtime::spawn_blocking(move || {
            let decoded = image::load_from_memory(&best.bytes)
                .map_err(|e| format!("Could not decode original for preview: {e}"))?;
            let preview = decoded.thumbnail(1600, 1000);
            let preview_width = preview.width();
            let preview_height = preview.height();
            let mut jpeg = Vec::new();
            preview.write_with_encoder(
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 87)
            ).map_err(|e| format!("Could not prepare original preview: {e}"))?;
            Ok::<(String, u32, u32), String>((
                format!("data:image/jpeg;base64,{}", BASE64.encode(&jpeg)),
                preview_width, preview_height
            ))
        }).await.map_err(|_| "Original image preview task was interrupted.".to_string())??;
    Ok(InspectedOriginal {
        original_url, width, height, preview_data_url,
        preview_width, preview_height, tried,
    })
}
