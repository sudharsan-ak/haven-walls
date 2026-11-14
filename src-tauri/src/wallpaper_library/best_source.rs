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
    publisher_page: Option<&str>,
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
        let mut request = client.get(url.clone());
        // Some public wallpaper CDNs expect a normal same-site page referrer.
        // Never leak a publisher's page URL to another host after redirect.
        if let Some(page) = publisher_page {
            if let Ok(referer) = reqwest::Url::parse(page) {
                if referer.scheme() == "https" &&
                    referer.host_str().map(|host| host.trim_start_matches("www.")) ==
                    url.host_str().map(|host| host.trim_start_matches("www.")) {
                    request = request.header(reqwest::header::REFERER, referer.as_str());
                }
            }
        }
        let mut response = request.send().await
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

// Explicit download links on an image's original webpage are different from
// social-media/OG preview images. Prefer the site's actual resolution options.
// Only visible hrefs with image/download semantics are considered; no scripts,
// search-result scraping, arbitrary crawling or page navigation is performed.
const MAX_DOWNLOAD_LINKS: usize = 7;

#[derive(Clone)]
struct DownloadLink {
    url: String,
    advertised_pixels: u64,
    landscape: bool,
    verified_same_wallpaper: bool,
}

fn page_image_id(url: &reqwest::Url) -> Option<&str> {
    let file = url.path().rsplit('/').next()?;
    let stem = file.rsplit_once('.').map(|(name, _)| name).unwrap_or(file);
    let id = stem.rsplit('-').next()?;
    if (3..=9).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) {
        Some(id)
    } else {
        None
    }
}

fn wallpapershome(url: &reqwest::Url) -> bool {
    matches!(url.host_str(), Some("wallpapershome.com" | "www.wallpapershome.com"))
}

fn advertised_dimensions(text: &str) -> Option<(u64, bool)> {
    // Bounded ASCII resolution scan: WIDTHxHEIGHT, e.g. 3840x2160.
    // These values are only hints for probe ordering. Every file is decoded.
    let bytes = text.as_bytes();
    let mut largest = None;
    for i in 0..bytes.len() {
        if !bytes[i].is_ascii_digit() || (i > 0 && bytes[i - 1].is_ascii_digit()) {
            continue;
        }
        let mut mid = i;
        while mid < bytes.len() && bytes[mid].is_ascii_digit() && mid - i < 6 {
            mid += 1;
        }
        if mid == i || mid >= bytes.len() || !matches!(bytes[mid], b'x' | b'X') {
            continue;
        }
        let mut end = mid + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() && end - mid <= 6 {
            end += 1;
        }
        let Ok(width) = text[i..mid].parse::<u32>() else { continue };
        let Ok(height) = text[mid + 1..end].parse::<u32>() else { continue };
        if !(700..=12000).contains(&width) || !(450..=12000).contains(&height) {
            continue;
        }
        let pixels = u64::from(width) * u64::from(height);
        let landscape = width >= height;
        if largest.as_ref().is_none_or(|(prior, prior_landscape): &(u64, bool)|
            pixels > *prior || (pixels == *prior && landscape && !*prior_landscape)) {
            largest = Some((pixels, landscape));
        }
    }
    largest
}

fn original_download_links(page_url: &str, html: &[u8]) -> Vec<DownloadLink> {
    let Ok(base) = reqwest::Url::parse(page_url) else { return Vec::new() };
    let page_host = base.host_str().unwrap_or("").trim_start_matches("www.");
    let wallpaper_id = if wallpapershome(&base) { page_image_id(&base) } else { None };
    let text = String::from_utf8_lossy(html);
    let lower = text.to_ascii_lowercase();
    let mut offset = 0usize;
    let mut scanned = 0usize;
    let mut downloads: Vec<DownloadLink> = Vec::new();

    while offset < lower.len() && scanned < 450 {
        let Some(relative) = lower[offset..].find("<a") else { break };
        let start = offset + relative;
        let after_a = lower.as_bytes().get(start + 2).copied().unwrap_or(b' ');
        if !after_a.is_ascii_whitespace() && after_a != b'>' { offset = start + 2; continue; }
        let Some(open_end) = lower[start..].find('>') else { break };
        let open_end = start + open_end + 1;
        if open_end - start > 3072 { offset = open_end; continue; }
        let Some(close_at) = lower[open_end..].find("</a>") else { break };
        let close = open_end + close_at;
        offset = close + 4;
        scanned += 1;
        if close - open_end > 1536 { continue; }
        let tag = &text[start..open_end];
        let Some(href) = tag_attribute(tag, "href") else { continue };
        let raw = html_entities(&href);
        if raw.len() > 4096 { continue; }
        let Ok(url) = base.join(&raw) else { continue };
        if url.scheme() != "https" || !url.username().is_empty() ||
            url.password().is_some() || url.as_str().len() > 4096 {
            continue;
        }
        let host = url.host_str().unwrap_or("").trim_start_matches("www.");
        // Only the publisher's own image/download endpoint, not advertisements
        // or arbitrary external links embedded on a page.
        if host != page_host && !host.ends_with(&format!(".{page_host}")) {
            continue;
        }
        let path = url.path().to_ascii_lowercase();
        let direct_image = [".jpg", ".jpeg", ".png", ".webp", ".avif"]
            .iter().any(|ext| path.ends_with(ext));
        let download_path = path.contains("/download/") || path.contains("/wallpaper/download");
        if !direct_image && !download_path { continue; }
        let label = lower[open_end..close].trim();
        let title = tag_attribute(tag, "title")
            .unwrap_or_default().to_ascii_lowercase();
        let advertised = advertised_dimensions(url.as_str())
            .or_else(|| advertised_dimensions(label))
            .or_else(|| advertised_dimensions(&title));
        let indicates_download = label.contains("download") ||
            label.contains("4k") || label.contains("original") ||
            title.contains("download") || title.contains("original") ||
            tag_attribute(tag, "download").is_some() || download_path;
        if advertised.is_none() && !indicates_download { continue; }

        // WallpapersHome uses a stable numeric wallpaper ID in BOTH its
        // preview page (..-5303.html) and download files (..-5303.jpg).
        // This is stronger than relying only on a similarity fingerprint.
        let same_wallpaper = wallpaper_id.is_some_and(|id| {
            wallpapershome(&url) && path.contains("/images/wallpapers/") &&
                page_image_id(&url) == Some(id)
        });
        if wallpaper_id.is_some() && !same_wallpaper { continue; }
        let (advertised_pixels, landscape) = advertised.unwrap_or_else(|| {
            if label.contains("8k") || title.contains("8k") { (7680 * 4320, true) }
            else if label.contains("4k") || title.contains("4k") { (3840 * 2160, true) }
            else { (0, true) }
        });
        if downloads.iter().any(|link| link.url == url.as_str()) { continue; }
        downloads.push(DownloadLink {
            url: url.to_string(), advertised_pixels, landscape,
            verified_same_wallpaper: same_wallpaper,
        });
    }

    // For equal pixel counts, prefer desktop/landscape versions over mobile
    // portrait crops of the same wallpaper.
    downloads.sort_by(|a, b|
        b.advertised_pixels.cmp(&a.advertised_pixels)
            .then_with(|| b.landscape.cmp(&a.landscape)));
    downloads.truncate(MAX_DOWNLOAD_LINKS);
    downloads
}

fn is_google_search_page(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "google.com" || host.ends_with(".google.com") ||
        host.ends_with(".gstatic.com") || host.ends_with(".googleusercontent.com")
}

async fn probe(url: String, publisher_page: Option<&str>) -> Result<Probe, String> {
    let bytes = fetch_public_bytes(&url, MAX_IMAGE_BYTES, false, publisher_page).await?;
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
    let mut resolution_downloads = Vec::new();
    if !page.is_empty() && !is_google_search_page(&page) &&
        secure_url(&page).is_ok() {
        if let Ok(html) = fetch_public_bytes(&page, MAX_HTML_BYTES, true, None).await {
            resolution_downloads = original_download_links(&page, &html);
            site_candidates = image_metadata_links(&page, &html);
        }
    }
    let start = Instant::now();
    let mut best: Option<Probe> = None;
    let mut reference_hash: Option<(u64, f64)> = None;
    let mut tried = 0usize;
    let mut last_error = String::new();
    // The selected image URL anchors visual identity first. Then prefer
    // publisher-provided resolution downloads over social preview metadata,
    // rather than exhausting the time budget on thumbnails first.
    let mut selected = urls.into_iter();
    let first = selected.next();
    let remaining = selected;
    let order = first.into_iter().map(|url| (url, false, false, 0u64))
        .chain(resolution_downloads.into_iter()
            .map(|link| (link.url, true, link.verified_same_wallpaper, link.advertised_pixels)))
        .chain(remaining.map(|url| (url, false, false, 0u64)))
        .chain(site_candidates.into_iter().map(|url| (url, true, false, 0u64)));
    for (url, from_page, same_wallpaper_id, advertised_pixels) in order {
        if tried >= MAX_CANDIDATES || start.elapsed() >= TOTAL_PROBE_TIME { break; }
        // Once a verified 4K file is found, no need to download the site's
        // advertised smaller 1080p/1440p variants of that very same picture.
        if advertised_pixels > 0 && best.as_ref().is_some_and(|existing|
            u64::from(existing.width) * u64::from(existing.height) >= advertised_pixels
        ) { continue; }
        if from_page && best.is_none() && !same_wallpaper_id { continue; }
        if from_page && secure_url(&url).is_err() { continue; }
        tried += 1;
        match probe(url, if page.is_empty() { None } else { Some(&page) }).await {
            Ok(candidate) => {
                if from_page {
                    if let Some(ref baseline) = best {
                        // A publisher may offer different crops under the same
                        // wallpaper ID. Don't substitute a mobile portrait crop
                        // for a landscape wallpaper selected from Google.
                        if same_wallpaper_id &&
                            (candidate.width >= candidate.height) !=
                            (baseline.width >= baseline.height) {
                            continue;
                        }
                        if !same_wallpaper_id && !related_picture(&candidate, baseline) {
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
