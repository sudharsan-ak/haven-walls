//! Approved-source discovery for the protected offline rotation reserve.
//! No Google scraping, no Bing image reuse guesses, no Unsplash wallpaper API.
//! First enabled automatic provider: Commons files whose *individual* metadata
//! explicitly identifies a public-domain/CC0 license and no copyright claim.
use crate::{app_settings, local_storage::{self, StorageLock}, wallpaper_library};
use image::GenericImageView;
use rusqlite::params;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, time::Duration};
use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};

pub const RESERVE_TARGET: usize = 10;
/// Bounded, approved discovery topics. These labels choose fixed Commons
/// queries; no arbitrary user-supplied query reaches the remote provider.
pub const DISCOVERY_TOPICS: [&str; 8] = [
    "nature", "space", "cities", "mountains",
    "oceans", "wildlife", "architecture", "abstract",
];
const MAX_SOURCE_BYTES: usize = 768 * 1024;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

/// Preserve Commons' rate-limit hint instead of losing it in a string.
#[derive(Debug)]
pub struct DiscoveryFailure {
    pub message: String,
    pub retry_after_seconds: Option<u64>,
    pub rate_limited: bool,
}
impl From<String> for DiscoveryFailure {
    fn from(message: String) -> Self {
        let rate_limited = message.contains("HTTP 429") || message.contains("HTTP 503");
        Self { message, retry_after_seconds: None, rate_limited }
    }
}
fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.min(172_800));
    }
    let deadline = DateTime::parse_from_rfc2822(value).ok()?;
    let remaining = (deadline.timestamp() - Utc::now().timestamp()).max(0) as u64;
    Some(remaining.min(172_800))
}

#[derive(Clone, Debug)]
struct ApprovedImage {
    url: String,
    page_url: String,
    title: String,
    license: String,
    width: u32,
    height: u32,
}

fn field<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or("")
}
fn license_value<'a>(info: &'a Value, name: &str) -> &'a str {
    info.pointer(&format!("/extmetadata/{name}/value"))
        .and_then(Value::as_str).unwrap_or("")
}

/// Only accept explicitly marked public-domain / CC0 material. General
/// Creative Commons Attribution licenses require attribution logic we have
/// not yet implemented for automatic desktop use.
fn approved_license(info: &Value) -> Option<String> {
    let label = license_value(info, "LicenseShortName").trim().to_ascii_lowercase();
    let url = license_value(info, "LicenseUrl").to_ascii_lowercase();
    let unrestricted = label == "cc0" || label == "cc0 1.0" ||
        label == "public domain" || label.starts_with("public domain mark") ||
        url.starts_with("https://creativecommons.org/publicdomain/zero/") ||
        url.starts_with("https://creativecommons.org/publicdomain/mark/");
    let copyright = license_value(info, "Copyrighted").trim();
    let nonfree = license_value(info, "NonFree").trim();
    if unrestricted && copyright.eq_ignore_ascii_case("false")
        && !nonfree.eq_ignore_ascii_case("true") {
        Some(if label.contains("cc0") || url.contains("/zero/") {
            "CC0".into()
        } else { "Public domain".into() })
    } else {
        None
    }
}

fn parse_commons(data: &Value, min_width: u32, min_height: u32) -> Vec<ApprovedImage> {
    let mut result = Vec::new();
    let Some(pages) = data.pointer("/query/pages").and_then(Value::as_array) else {
        return result;
    };
    for page in pages {
        let Some(info) = page.pointer("/imageinfo/0") else { continue; };
        let Some(license) = approved_license(info) else { continue; };
        let width = info.get("width").and_then(Value::as_u64).unwrap_or_default();
        let height = info.get("height").and_then(Value::as_u64).unwrap_or_default();
        if width < u64::from(min_width) || height < u64::from(min_height) ||
            width.saturating_mul(height) > 90_000_000 { continue; }
        if !matches!(field(info, "mime"), "image/jpeg" | "image/png" | "image/webp") {
            continue;
        }
        let url = field(info, "url");
        let page_url = field(info, "descriptionurl");
        let Ok(parsed) = reqwest::Url::parse(url) else { continue };
        let Ok(source) = reqwest::Url::parse(page_url) else { continue };
        if parsed.scheme() != "https" || parsed.host_str() != Some("upload.wikimedia.org")
            || parsed.username() != "" || parsed.password().is_some() ||
            source.scheme() != "https" || source.host_str() != Some("commons.wikimedia.org") {
            continue;
        }
        if !["jpg","jpeg","png","webp"].iter().any(|ext|
            parsed.path().to_ascii_lowercase().ends_with(&format!(".{ext}"))) {
            continue;
        }
        let title = field(page, "title").trim_start_matches("File:")
            .replace('_', " ").chars().take(160).collect::<String>();
        if title.trim().is_empty() { continue; }
        result.push(ApprovedImage {
            url: parsed.to_string(), page_url: source.to_string(), title,
            license, width: width as u32, height: height as u32,
        });
    }
    result
}

fn query_for_topic(topic: &str) -> &'static str {
    match topic {
        "space" => "public domain astronomy galaxies nebula stars filetype:bitmap",
        "cities" => "public domain city skyline panorama filetype:bitmap",
        "mountains" => "public domain mountain landscape peaks filetype:bitmap",
        "oceans" => "public domain ocean beach coast seascape filetype:bitmap",
        "wildlife" => "public domain wildlife nature animal photography filetype:bitmap",
        "architecture" => "public domain architecture building landmark filetype:bitmap",
        "abstract" => "public domain abstract colorful patterns art filetype:bitmap",
        _ => "public domain landscape mountains nature filetype:bitmap",
    }
}

async fn commons_options(topic: &str, page: u32,
    min_width: u32, min_height: u32) -> Result<Vec<ApprovedImage>, DiscoveryFailure> {
    let offset = ((page % 20) * 24).to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(14))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls; local wallpaper discovery)")
        .build().map_err(|_| "Could not initialize Commons discovery.".to_string())?;
    let response = client.get("https://commons.wikimedia.org/w/api.php")
        .query(&[
            ("action", "query"), ("generator", "search"),
            ("gsrsearch", query_for_topic(topic)),
            ("gsrnamespace", "6"), ("gsrlimit", "24"),
            ("gsroffset", offset.as_str()),
            ("prop", "imageinfo"),
            ("iiprop", "url|size|mime|extmetadata"),
            ("iiextmetadatafilter", "LicenseShortName|LicenseUrl|Copyrighted|NonFree"),
            ("format", "json"), ("formatversion", "2"),
        ]).send().await.map_err(|_| "Wikimedia Commons is unreachable.".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS ||
            status == reqwest::StatusCode::SERVICE_UNAVAILABLE;
        return Err(DiscoveryFailure {
            message: format!("Commons discovery returned HTTP {status}."),
            retry_after_seconds: if limited {
                retry_after_seconds(response.headers())
            } else { None },
            rate_limited: limited,
        });
    }
    if response.content_length().is_some_and(|size| size > MAX_SOURCE_BYTES as u64) {
        return Err("Commons metadata exceeded the response limit.".to_string().into());
    }
    let bytes = response.bytes().await
        .map_err(|_| "Commons metadata transfer failed.".to_string())?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("Commons metadata exceeded the response limit.".to_string().into());
    }
    let data: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Commons returned invalid image metadata.".to_string())?;
    Ok(parse_commons(&data, min_width, min_height))
}

fn known_pages(app: &AppHandle) -> Result<Vec<String>, String> {
    let state = app.state::<StorageLock>();
    let _guard = state.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    let mut stmt = conn.prepare("SELECT COALESCE(source_page,'') FROM wallpapers")
        .map_err(|e| format!("Could not inspect existing photo sources: {e}"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Could not inspect photo sources: {e}"))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Could not read photo source: {e}"))?);
    }
    Ok(result)
}

/// Returns true only when a new valid reserve file and its SQLite metadata
/// have been fully committed. The StorageLock covers validation, deduplication
/// and all file+DB changes; downloads take place outside this lock.
fn save_approved(app: &AppHandle, source: &ApprovedImage,
    bytes: Vec<u8>) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return Err("Approved source returned an invalid file size.".into());
    }
    let state = app.state::<StorageLock>();
    let _guard = state.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let mut conn = app_settings::open_database(&paths)?;
    let settings = app_settings::read_settings(&conn)?;
    // Check provider exclusions again after the download, under the same
    // lock as the final write. Excluded sources must not enter the reserve.
    let title = source.title.to_lowercase();
    let origin = format!("{} {} Wikimedia Commons", source.url, source.page_url).to_lowercase();
    if settings.excluded_keywords.iter().any(|word| title.contains(&word.to_lowercase())) ||
        settings.excluded_sources.iter().any(|word| origin.contains(&word.to_lowercase())) {
        return Ok(false);
    }
    let reserve_size: i64 = conn.query_row(
        "SELECT COUNT(*) FROM wallpaper_files WHERE storage_class='reserve'",
        [], |row| row.get(0),
    ).map_err(|e| format!("Could not inspect the offline reserve: {e}"))?;
    if reserve_size >= RESERVE_TARGET as i64 { return Ok(false); }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wallpaper_fingerprints (
            wallpaper_id TEXT PRIMARY KEY REFERENCES wallpapers(id) ON DELETE CASCADE,
            dhash TEXT NOT NULL
        );"
    ).map_err(|e| format!("Could not inspect similar photos: {e}"))?;
    let (image, format) = wallpaper_library::image_format(&bytes)?;
    let (width, height) = image.dimensions();
    let (min_width, min_height) = wallpaper_library::min_dimensions(&settings.minimum_resolution);
    if width < min_width || height < min_height || width < height ||
        !settings.allowed_image_types.contains(&format) {
        return Ok(false);
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM wallpapers WHERE id=?1)",
        params![digest], |row| row.get(0),
    ).map_err(|e| format!("Could not check existing wallpapers: {e}"))?;
    if exists { return Ok(false); }
    let fingerprint = wallpaper_library::perceptual_hash(&image);
    if settings.duplicate_sensitivity > 0 {
        let mut stmt = conn.prepare("SELECT dhash FROM wallpaper_fingerprints LIMIT 5000")
            .map_err(|e| format!("Could not check image similarities: {e}"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Could not read image similarities: {e}"))?;
        let threshold = u32::from(settings.duplicate_sensitivity) * 10 / 100;
        for row in rows {
            if let Ok(other) = u64::from_str_radix(
                &row.map_err(|e| format!("Could not inspect fingerprint: {e}"))?, 16
            ) {
                if (other ^ fingerprint).count_ones() <= threshold {
                    return Ok(false);
                }
            }
        }
    }
    let filename = format!("{digest}.{format}");
    let final_path = paths.offline_reserve().join(&filename);
    let staging_path = paths.offline_reserve().join(format!("{digest}.staging"));
    if final_path.exists() { return Ok(false); }
    {
        let mut output = fs::OpenOptions::new().create_new(true).write(true)
            .open(&staging_path)
            .map_err(|e| format!("Could not stage offline wallpaper: {e}"))?;
        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            let _ = fs::remove_file(&staging_path);
            return Err(format!("Could not write offline image: {error}"));
        }
    }
    if let Err(error) = fs::rename(&staging_path, &final_path) {
        let _ = fs::remove_file(&staging_path);
        return Err(format!("Could not finish offline file: {error}"));
    }
    let transaction = (|| -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO wallpapers
              (id,title,source,source_page,original_url,creator,rights_status,
               width,height,checksum_sha256,favorite)
             VALUES (?1,?2,'Wikimedia Commons',?3,?4,'Wikimedia Commons contributor',?5,?6,?7,?1,0)",
            params![digest,source.title,source.page_url,source.url,
                format!("{}: individual Commons file metadata; source page retained.", source.license),
                width,height],
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO wallpaper_files
              (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
             VALUES (?1,?1,?2,'reserve',?3,?1)",
            params![digest,filename,bytes.len() as i64],
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO wallpaper_fingerprints(wallpaper_id,dhash) VALUES(?1,?2)",
            params![digest,format!("{fingerprint:016x}")],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    })();
    if let Err(error) = transaction {
        let _ = fs::remove_file(&final_path);
        return Err(format!("Could not save reserve metadata: {error}"));
    }
    Ok(true)
}

/// Performs at most three bounded image downloads per discovery attempt,
/// adds at most one approved file, and never silently accepts rights-unknown
/// provider material.
pub fn replenish_once(app: &AppHandle, topic: &str, page: u32)
    -> Result<bool, DiscoveryFailure> {
    let settings = {
        let state = app.state::<StorageLock>();
        let _guard = state.0.lock().map_err(|_| "Storage is busy".to_string())?;
        let paths = local_storage::current_paths(app)?;
        local_storage::prepare_folders(&paths)?;
        let conn = app_settings::open_database(&paths)?;
        app_settings::read_settings(&conn)?
    };
    let (min_width,min_height) =
        wallpaper_library::min_dimensions(&settings.minimum_resolution);
    let options = tauri::async_runtime::block_on(
        commons_options(topic, page, min_width, min_height)
    )?;
    let known = known_pages(app)?;
    let mut attempted = 0usize;
    let mut last_error: Option<DiscoveryFailure> = None;
    for candidate in options {
        if known.contains(&candidate.page_url) { continue; }
        let title = candidate.title.to_lowercase();
        let origin = format!("{} {} Wikimedia Commons", candidate.url,candidate.page_url)
            .to_lowercase();
        if settings.excluded_keywords.iter().any(|s| title.contains(&s.to_lowercase())) ||
            settings.excluded_sources.iter().any(|s| origin.contains(&s.to_lowercase())) {
            continue;
        }
        attempted += 1;
        let response = tauri::async_runtime::block_on(
            wallpaper_library::best_source::fetch_public_bytes(
                &candidate.url, MAX_FILE_BYTES, false, Some(&candidate.page_url)
            )
        );
        match response {
            Ok(bytes) => match save_approved(app, &candidate, bytes) {
                Ok(true) => return Ok(true),
                Ok(false) => {},
                Err(error) => last_error = Some(DiscoveryFailure::from(error)),
            },
            Err(error) => {
                let failure = DiscoveryFailure::from(error);
                if failure.rate_limited {
                    // Do not send another upload CDN request after HTTP 429.
                    return Err(failure);
                }
                last_error = Some(failure);
            },
        }
        if attempted >= 3 { break; }
    }
    if let Some(error) = last_error {
        Err(DiscoveryFailure {
            message: format!("No eligible Commons image saved: {}", error.message),
            ..error
        })
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_after_seconds_supports_delta_and_http_date() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("1200"));
        assert_eq!(retry_after_seconds(&headers), Some(1200));
        headers.insert(reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("Wed, 21 Oct 2099 07:28:00 GMT"));
        assert_eq!(retry_after_seconds(&headers), Some(172800));
    }
    #[test]
    fn public_domain_requires_explicit_non_copyright_metadata() {
        let allowed = serde_json::json!({"extmetadata": {
            "LicenseShortName":{"value":"CC0"},
            "Copyrighted":{"value":"False"}
        }});
        assert_eq!(approved_license(&allowed).as_deref(), Some("CC0"));
        let unknown = serde_json::json!({"extmetadata": {
            "LicenseShortName":{"value":"CC BY-SA 4.0"},
            "Copyrighted":{"value":"False"}
        }});
        assert!(approved_license(&unknown).is_none());
        let missing = serde_json::json!({"extmetadata": {
            "LicenseShortName":{"value":"Public domain"}
        }});
        assert!(approved_license(&missing).is_none());
    }
    #[test]
    fn all_topics_are_supported_by_static_queries() {
        assert_eq!(DISCOVERY_TOPICS.len(), 8);
        let mut unique = std::collections::HashSet::new();
        for topic in DISCOVERY_TOPICS {
            assert!(unique.insert(topic));
            assert!(query_for_topic(topic).contains("filetype:bitmap"));
        }
        assert_ne!(query_for_topic("oceans"), query_for_topic("cities"));
    }

    #[test]
    fn rejects_untrusted_hosts_and_small_images() {
        let sample = serde_json::json!({"query":{"pages":[
            {"title":"File:mountain.jpg","imageinfo":[{
                "url":"https://attacker.example/image.jpg",
                "descriptionurl":"https://commons.wikimedia.org/wiki/File:mountain.jpg",
                "mime":"image/jpeg","width":4000,"height":2500,
                "extmetadata":{"LicenseShortName":{"value":"CC0"},
                    "Copyrighted":{"value":"False"}}
            }]}
        ]}});
        assert!(parse_commons(&sample,1920,1080).is_empty());
    }
}
