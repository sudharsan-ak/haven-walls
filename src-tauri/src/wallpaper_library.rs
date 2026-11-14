//! User-approved image ingestion and managed wallpaper library.
//! Neither automatic desktop changes nor background downloading occur here.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Write},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::PathBuf,
    sync::MutexGuard,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use crate::{
    app_settings::{self, AppSettings},
    local_storage::{self, DataPaths, StorageLock},
};

const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 90_000_000;
const MAX_TRANSFER_SECONDS: u64 = 22;
const THUMBNAIL_SIZE: u32 = 420;

#[derive(Debug, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ImportMetadata {
    title: String,
    source: String,
    source_page: String,
    original_url: String,
    credit: String,
    rights_note: String,
    /// Explicit confirmation: user has checked image use/terms themselves.
    rights_confirmed: bool,
    allow_below_minimum: bool,
    allow_similar: bool,
}

impl ImportMetadata {
    fn clean(&mut self) -> Result<(), String> {
        for (value, limit, label) in [
            (&mut self.title, 180, "Title"),
            (&mut self.source, 120, "Source"),
            (&mut self.source_page, 2048, "Source link"),
            (&mut self.original_url, 4096, "Original link"),
            (&mut self.credit, 240, "Photo credit"),
            (&mut self.rights_note, 900, "Rights note"),
        ] {
            *value = value.trim().to_string();
            if value.len() > limit || value.contains('\0') {
                return Err(format!("{label} is too long or contains invalid characters."));
            }
        }
        if !self.source_page.is_empty() && !self.source_page.starts_with("https://") {
            return Err("Source page must be a public HTTPS link or left blank.".into());
        }
        if self.title.is_empty() { self.title = "Untitled wallpaper".into(); }
        if self.source.is_empty() { self.source = "Local import".into(); }
        if self.rights_note.is_empty() {
            self.rights_note = "Image usage rights are not independently verified by Haven Walls".into();
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct LibraryWallpaper {
    id: String,
    title: String,
    source: String,
    source_page: String,
    original_url: String,
    credit: String,
    rights_note: String,
    width: u32,
    height: u32,
    bytes: u64,
    format: String,
    favorite: bool,
    created_at: String,
    thumbnail_data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct ImportOutcome {
    wallpaper: LibraryWallpaper,
    already_saved: bool,
    note: String,
}

fn storage_guard<'a>(state: &'a State<'_, StorageLock>) -> Result<MutexGuard<'a, ()>, String> {
    state.0.lock().map_err(|_| "Wallpaper storage is temporarily unavailable".to_string())
}

fn connected(app: &AppHandle) -> Result<(DataPaths, Connection, AppSettings), String> {
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    fs::create_dir_all(paths.library().join("thumbs"))
        .map_err(|e| format!("Could not create the thumbnail directory: {e}"))?;
    let conn = app_settings::open_database(&paths)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wallpaper_fingerprints (
           wallpaper_id TEXT PRIMARY KEY REFERENCES wallpapers(id) ON DELETE CASCADE,
           dhash TEXT NOT NULL
         );"
    ).map_err(|e| format!("Could not initialize image fingerprint metadata: {e}"))?;
    let settings = app_settings::read_settings(&conn)?;
    Ok((paths, conn, settings))
}

fn safe_filename(id: &str, format: &str) -> Result<String, String> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) ||
       !["jpg", "png", "webp"].contains(&format) {
        return Err("Wallpaper file identifier is invalid".into());
    }
    Ok(format!("{id}.{format}"))
}

fn thumb_path(paths: &DataPaths, id: &str) -> Result<PathBuf, String> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Wallpaper thumbnail identifier is invalid".into());
    }
    Ok(paths.library().join("thumbs").join(format!("{id}.jpg")))
}

fn validate_source_exclusions(metadata: &ImportMetadata, settings: &AppSettings) -> Result<(), String> {
    let title = metadata.title.to_lowercase();
    let source = format!("{} {} {}",
        metadata.source, metadata.source_page, metadata.original_url).to_lowercase();
    for excluded in &settings.excluded_keywords {
        if !excluded.is_empty() && title.contains(&excluded.to_lowercase()) {
            return Err(format!("This image matches excluded keyword '{excluded}'. Change the rule in Settings if needed."));
        }
    }
    for excluded in &settings.excluded_sources {
        if !excluded.is_empty() && source.contains(&excluded.to_lowercase()) {
            return Err(format!("This image matches excluded source '{excluded}'. Change the rule in Settings if needed."));
        }
    }
    Ok(())
}

fn image_format(bytes: &[u8]) -> Result<(DynamicImage, String), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format().map_err(|e| format!("Could not determine image format: {e}"))?;
    let format = reader.format().ok_or_else(|| "This is not a supported image".to_string())?;
    let extension = match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::WebP => "webp",
        _ => return Err("Only actual JPEG, PNG and WebP images are supported.".into()),
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16000);
    limits.max_image_height = Some(16000);
    limits.max_alloc = Some(400 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|e| format!("Could not decode image pixels: {e}"))?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("Image dimensions exceed Haven Walls' safe decoding limit.".into());
    }
    Ok((image, extension.into()))
}

fn perceptual_hash(image: &DynamicImage) -> u64 {
    let strip = image.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            if strip.get_pixel(x, y)[0] > strip.get_pixel(x + 1, y)[0] {
                hash |= 1;
            }
        }
    }
    hash
}

fn min_dimensions(quality: &str) -> (u32, u32) {
    match quality {
        "4K" => (3840, 2160),
        "1440p" => (2560, 1440),
        _ => (1920, 1080),
    }
}

fn encode_thumbnail(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let thumbnail = image.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    let mut bytes = Cursor::new(Vec::new());
    thumbnail.write_to(&mut bytes, ImageFormat::Jpeg)
        .map_err(|e| format!("Could not encode library thumbnail: {e}"))?;
    Ok(bytes.into_inner())
}

fn file_record(
    conn: &Connection,
    paths: &DataPaths,
    id: &str,
) -> Result<Option<(String, u64)>, String> {
    let result: Option<(String, i64)> = conn.query_row(
        "SELECT relative_path, bytes FROM wallpaper_files
         WHERE wallpaper_id = ?1 AND storage_class = 'managed' LIMIT 1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| format!("Could not find wallpaper file: {e}"))?;
    let Some((filename, size)) = result else { return Ok(None); };
    // Filenames are generated from sha256 and the validated decoder format;
    // never accept a relative path from the UI or user-controlled file text.
    let valid = ["jpg", "png", "webp"].iter()
        .any(|fmt| safe_filename(id, fmt).ok().as_deref() == Some(filename.as_str()));
    if !valid || !paths.library().join(&filename).is_file() {
        return Err("Managed image file is missing or has an unexpected path.".into());
    }
    Ok(Some((filename, size.max(0) as u64)))
}

fn thumbnail_data(paths: &DataPaths, id: &str) -> String {
    thumb_path(paths, id).ok()
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)))
        .unwrap_or_default()
}

fn list_items(conn: &Connection, paths: &DataPaths) -> Result<Vec<LibraryWallpaper>, String> {
    let mut statement = conn.prepare(
        "SELECT w.id, w.title, w.source, COALESCE(w.source_page, ''),
                COALESCE(w.original_url, ''), COALESCE(w.creator, ''),
                w.rights_status, w.width, w.height, w.favorite, w.created_at
         FROM wallpapers w ORDER BY w.created_at DESC, w.id DESC LIMIT 500"
    ).map_err(|e| format!("Could not read wallpaper library: {e}"))?;
    let iterator = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?,
            row.get::<_, String>(4)?, row.get::<_, String>(5)?,
            row.get::<_, String>(6)?, row.get::<_, u32>(7)?,
            row.get::<_, u32>(8)?, row.get::<_, bool>(9)?,
            row.get::<_, String>(10)?,
        ))
    }).map_err(|e| format!("Could not list saved images: {e}"))?;
    let mut results = Vec::new();
    for record in iterator {
        let (id, title, source, source_page, original_url, credit,
            rights_note, width, height, favorite, created_at) =
            record.map_err(|e| format!("Could not read saved image: {e}"))?;
        let file = file_record(conn, paths, &id)?;
        let (format, bytes) = file
            .map(|(file, size)| (file.rsplit('.').next().unwrap_or("jpg").to_string(), size))
            .unwrap_or((String::new(), 0));
        results.push(LibraryWallpaper {
            thumbnail_data_url: thumbnail_data(paths, &id),
            id, title, source, source_page, original_url, credit, rights_note,
            width, height, bytes, format, favorite, created_at,
        });
    }
    Ok(results)
}

fn import_bytes(
    app: &AppHandle,
    state: &State<'_, StorageLock>,
    bytes: Vec<u8>,
    mut metadata: ImportMetadata,
    is_remote: bool,
) -> Result<ImportOutcome, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must contain data and be no larger than 32 MB.".into());
    }
    metadata.clean()?;
    if !is_remote && metadata.original_url.starts_with("blob:") {
        metadata.original_url.clear();
    }
    let _guard = storage_guard(state)?;
    let (paths, mut conn, settings) = connected(app)?;
    if !metadata.rights_confirmed && !settings.skip_import_confirmation {
        return Err("Review the image's usage rights or enable Quick Save to Library in Settings.".into());
    }
    if !metadata.rights_confirmed {
        // A saved Quick Save preference removes repetitive UI only. Do not
        // record a false claim that the user verified this image's license.
        metadata.rights_note.push_str(" · Quick Save: usage permission not confirmed for this image.");
    }
    if is_remote { validate_source_exclusions(&metadata, &settings)?; }

    let (image, format) = image_format(&bytes)?;
    if !settings.allowed_image_types.contains(&format) {
        return Err(format!("The {format} format is disabled in Settings."));
    }
    let (width, height) = image.dimensions();
    let (minimum_width, minimum_height) = min_dimensions(&settings.minimum_resolution);
    // Resolution checks are orientation-aware: a 1080 × 1920 portrait image
    // is eligible at the 1080p tier just like a 1920 × 1080 landscape.
    let (image_long, image_short) = (width.max(height), width.min(height));
    if !metadata.allow_below_minimum &&
        (image_long < minimum_width || image_short < minimum_height) {
        return Err(format!(
            "Loaded image is {width} × {height}, below your {} minimum. \
             Check 'Allow smaller images' to import it anyway.",
            settings.minimum_resolution
        ));
    }

    let digest = format!("{:x}", Sha256::digest(&bytes));
    let existing: Option<String> = conn.query_row(
        "SELECT id FROM wallpapers WHERE checksum_sha256=?1 LIMIT 1",
        params![digest],
        |row| row.get(0)
    ).optional().map_err(|e| format!("Could not check exact duplicates: {e}"))?;
    if let Some(existing_id) = existing {
        let entries = list_items(&conn, &paths)?;
        let entry = entries.into_iter().find(|item| item.id == existing_id)
            .ok_or_else(|| "Existing duplicate was found but its record could not be loaded.".to_string())?;
        return Ok(ImportOutcome {
            wallpaper: entry,
            already_saved: true,
            note: "Exact duplicate already exists in your managed Library. No new file was written.".into(),
        });
    }

    let signature = perceptual_hash(&image);
    if !metadata.allow_similar && settings.duplicate_sensitivity > 0 {
        let mut stmt = conn.prepare(
            "SELECT dhash FROM wallpaper_fingerprints LIMIT 5000"
        ).map_err(|e| format!("Could not inspect similar images: {e}"))?;
        let hashes = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Could not inspect fingerprints: {e}"))?;
        let threshold = (u32::from(settings.duplicate_sensitivity) * 10) / 100;
        for text in hashes {
            let text = text.map_err(|e| format!("Could not inspect fingerprint: {e}"))?;
            if let Ok(other) = u64::from_str_radix(&text, 16) {
                if (other ^ signature).count_ones() <= threshold {
                    return Err(format!(
                        "A visually similar image already exists (sensitivity {}%). \
                         To keep both, check 'Allow similar images'.",
                        settings.duplicate_sensitivity
                    ));
                }
            }
        }
    }

    let filename = safe_filename(&digest, &format)?;
    let final_path = paths.library().join(&filename);
    if final_path.exists() {
        return Err("An unmanaged file already exists at the destination. Refusing to overwrite it.".into());
    }
    let thumb = encode_thumbnail(&image)?;
    let thumbnail_path = thumb_path(&paths, &digest)?;
    let stage_path = paths.library().join(format!("{digest}.importing"));
    {
        let mut output = fs::OpenOptions::new()
            .write(true).create_new(true).open(&stage_path)
            .map_err(|e| format!("Could not stage wallpaper file: {e}"))?;
        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            let _ = fs::remove_file(&stage_path);
            return Err(format!("Could not finish wallpaper file: {error}"));
        }
    }
    if let Err(error) = fs::rename(&stage_path, &final_path) {
        let _ = fs::remove_file(&stage_path);
        return Err(format!("Could not finalize wallpaper file: {error}"));
    }
    if let Err(error) = fs::write(&thumbnail_path, &thumb) {
        let _ = fs::remove_file(&final_path);
        return Err(format!("Could not save the library thumbnail: {error}"));
    }

    let transaction = conn.transaction()
        .map_err(|e| format!("Could not start database update: {e}"))?;
    let result = (|| -> Result<(), rusqlite::Error> {
        transaction.execute(
            "INSERT INTO wallpapers
             (id,title,source,source_page,original_url,creator,rights_status,
              width,height,checksum_sha256,favorite)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0)",
            params![
                digest, metadata.title, metadata.source, metadata.source_page,
                metadata.original_url, metadata.credit, metadata.rights_note,
                width, height, digest
            ]
        )?;
        transaction.execute(
            "INSERT INTO wallpaper_files
             (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
             VALUES (?1,?2,?3,'managed',?4,?5)",
            params![digest, digest, filename, bytes.len() as i64, digest]
        )?;
        transaction.execute(
            "INSERT INTO wallpaper_fingerprints (wallpaper_id,dhash) VALUES (?1,?2)",
            params![digest, format!("{signature:016x}")]
        )?;
        Ok(())
    })();
    if let Err(error) = result.and_then(|_| transaction.commit()) {
        let _ = fs::remove_file(final_path);
        let _ = fs::remove_file(thumbnail_path);
        return Err(format!("Could not save library metadata: {error}"));
    }
    let item = list_items(&conn, &paths)?.into_iter()
        .find(|item| item.id == digest)
        .ok_or_else(|| "Image was saved but its Library entry could not be loaded.".to_string())?;
    Ok(ImportOutcome {
        wallpaper: item,
        already_saved: false,
        note: format!(
            "Saved verified {width} × {height} {format} file in the managed Library. \
             Original local files and active Windows wallpapers remain unchanged."
        ),
    })
}

/// Base64 input is only accepted after an explicit user file selection.
#[tauri::command]
pub fn import_wallpaper_data(
    app: AppHandle,
    state: State<'_, StorageLock>,
    base64_data: String,
    metadata: ImportMetadata,
) -> Result<ImportOutcome, String> {
    if base64_data.len() > MAX_IMAGE_BYTES * 4 / 3 + 32 {
        return Err("Image data exceeds the 32 MB limit.".into());
    }
    let bytes = BASE64.decode(base64_data.trim())
        .map_err(|_| "Could not decode the selected local image.".to_string())?;
    import_bytes(&app, &state, bytes, metadata, false)
}

fn address_allowed(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(ip) => !(
            ip.is_private() || ip.is_loopback() || ip.is_link_local() ||
            ip.is_broadcast() || ip.is_unspecified() || ip.is_documentation() ||
            ip.is_multicast() || ip.octets()[0] == 0 ||
            (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])) ||
            ip.octets()[0] >= 224
        ),
        IpAddr::V6(ip) =>
            !(ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() ||
              ip.is_unicast_link_local() || ip.is_multicast() ||
              ip.to_ipv4_mapped().is_some()),
    }
}

fn secure_url(raw: &str) -> Result<(reqwest::Url, Vec<SocketAddr>), String> {
    if raw.len() > 4096 { return Err("Image address is too long.".into()); }
    let url = reqwest::Url::parse(raw)
        .map_err(|_| "Enter a valid HTTPS image URL.".to_string())?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443)
        || !url.username().is_empty() || url.password().is_some()
    {
        return Err("Only standard HTTPS image URLs without credentials are allowed.".into());
    }
    let host = url.host_str().ok_or_else(|| "Image URL has no host.".to_string())?;
    if !host.contains('.') || host == "localhost" || host.ends_with(".local") ||
       host.ends_with(".internal") || host.ends_with(".localhost") ||
       host.parse::<IpAddr>().is_ok()
    {
        return Err("The image address is not a permitted public HTTPS hostname.".into());
    }
    let addresses: Vec<SocketAddr> = (host, 443u16).to_socket_addrs()
        .map_err(|_| "Could not resolve the remote image host.".to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !address_allowed(address.ip())) {
        return Err("The image host resolves to a restricted network address.".into());
    }
    Ok((url, addresses))
}

/// One explicit network fetch only. Redirects, local/private IPs, and
/// unexpectedly large or non-image responses are rejected.
#[tauri::command]
pub async fn import_wallpaper_url(
    app: AppHandle,
    image_url: String,
    mut metadata: ImportMetadata,
) -> Result<ImportOutcome, String> {
    metadata.clean()?;
    let (url, resolved_addresses) = secure_url(&image_url)?;
    let host = url.host_str().ok_or_else(|| "Image has no host.".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &resolved_addresses)
        .timeout(Duration::from_secs(MAX_TRANSFER_SECONDS))
        .user_agent("HavenWalls/0.1 (user-approved wallpaper fetch)")
        .build().map_err(|e| format!("Could not prepare HTTPS download: {e}"))?;
    let mut response = client.get(url).send().await
        .map_err(|e| format!("Image download was rejected or timed out: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Image host returned HTTP {}. Try an original image URL or a downloaded local file.", response.status()));
    }
    if response.content_length().unwrap_or(0) > MAX_IMAGE_BYTES as u64 {
        return Err("Image exceeds the 32 MB download limit.".into());
    }
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
        let value = content_type.to_str().unwrap_or("");
        if !value.starts_with("image/") && !value.starts_with("application/octet-stream") {
            return Err("Image URL returned HTML or a non-image content type.".into());
        }
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(
        response.content_length().unwrap_or(0).min(MAX_IMAGE_BYTES as u64) as usize
    );
    while let Some(chunk) = response.chunk().await
        .map_err(|e| format!("Image download was interrupted: {e}"))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
            return Err("Image exceeds the 32 MB download limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    metadata.original_url = image_url;
    // Decoding and disk I/O are performed in blocking work, not on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageLock>();
        import_bytes(&app, &state, bytes, metadata, true)
    })
        .await.map_err(|_| "Wallpaper import operation was interrupted.".to_string())?
}

#[tauri::command]
pub fn list_library_wallpapers(
    app: AppHandle,
    state: State<'_, StorageLock>,
) -> Result<Vec<LibraryWallpaper>, String> {
    let _guard = storage_guard(&state)?;
    let (paths, conn, _) = connected(&app)?;
    list_items(&conn, &paths)
}

#[tauri::command]
pub fn get_library_wallpaper_image(
    app: AppHandle,
    state: State<'_, StorageLock>,
    id: String,
) -> Result<String, String> {
    let _guard = storage_guard(&state)?;
    let (paths, conn, _) = connected(&app)?;
    let (filename, size) = file_record(&conn, &paths, &id)?
        .ok_or_else(|| "That wallpaper is no longer in your Library.".to_string())?;
    if size > MAX_IMAGE_BYTES as u64 {
        return Err("Wallpaper is too large to show as an in-app preview.".into());
    }
    let path = paths.library().join(filename);
    let data = fs::read(path).map_err(|e| format!("Could not read saved wallpaper: {e}"))?;
    let mime = if data.starts_with(b"\x89PNG") { "image/png" }
        else if data.starts_with(b"RIFF") { "image/webp" }
        else { "image/jpeg" };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(data)))
}

#[tauri::command]
pub fn set_wallpaper_favorite(
    app: AppHandle,
    state: State<'_, StorageLock>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let _guard = storage_guard(&state)?;
    let (_, conn, _) = connected(&app)?;
    let affected = conn.execute(
        "UPDATE wallpapers SET favorite=?2 WHERE id=?1",
        params![id, favorite]
    ).map_err(|e| format!("Could not update favorite: {e}"))?;
    if affected == 0 {
        return Err("Wallpaper no longer exists in the Library.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn remove_library_wallpaper(
    app: AppHandle,
    state: State<'_, StorageLock>,
    id: String,
) -> Result<(), String> {
    let _guard = storage_guard(&state)?;
    let (paths, mut conn, _) = connected(&app)?;
    // Reserve the active working copy and currently-applied wallpapers.
    let used: i64 = conn.query_row(
        "SELECT COUNT(*) FROM wallpaper_files
         WHERE wallpaper_id=?1 AND storage_class IN ('active','reserve')",
        params![id], |row| row.get(0)
    ).map_err(|e| format!("Could not check active wallpaper copies: {e}"))?;
    if used > 0 {
        return Err("This wallpaper is protected by an active/offline copy. Replace it before removal.".into());
    }
    let (filename, _) = file_record(&conn, &paths, &id)?
        .ok_or_else(|| "Wallpaper not found or its managed file is missing.".to_string())?;
    let data_path = paths.library().join(filename);
    let thumbnail = thumb_path(&paths, &id)?;
    // Rename into a private staging name first, then commit metadata, so an
    // interrupted SQLite update can return the original file on error.
    let staged = paths.library().join(format!("{id}.deleting"));
    fs::rename(&data_path, &staged)
        .map_err(|e| format!("Could not stage wallpaper removal: {e}"))?;
    let transaction = conn.transaction()
        .map_err(|e| {
            let _ = fs::rename(&staged, &data_path);
            format!("Could not start wallpaper deletion: {e}")
        })?;
    let committed = transaction
        .execute("DELETE FROM wallpapers WHERE id=?1", params![id])
        .and_then(|affected| {
            if affected == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            transaction.commit()
        });
    if let Err(error) = committed {
        let _ = fs::rename(&staged, &data_path);
        return Err(format!("Could not finish wallpaper deletion: {error}"));
    }
    // Staged image removal cannot affect the user's original local image.
    fs::remove_file(&staged)
        .map_err(|e| format!("Wallpaper removed from Library but its old file could not be deleted: {e}"))?;
    let _ = fs::remove_file(thumbnail);
    Ok(())
}


/// Open a recorded *online* source in the system default web browser.
/// Native host action: Google Images' remote child webview has no permission
/// to invoke this. Never open local paths or untrusted URL schemes.
#[tauri::command]
pub fn open_wallpaper_source(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if url.len() > 4096 { return Err("Source URL is too long.".into()); }
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "This entry has no valid online source URL.".to_string())?;
    let host = parsed.host_str()
        .ok_or_else(|| "This entry has no usable source hostname.".to_string())?;
    if parsed.scheme() != "https" || parsed.username() != "" ||
        parsed.password().is_some() || !host.contains('.') ||
        host.parse::<IpAddr>().is_ok() ||
        host == "localhost" || host.ends_with(".localhost") ||
        host.ends_with(".local") || host.ends_with(".internal")
    {
        return Err("Only public HTTPS source pages and images can be opened.".into());
    }
    app.opener().open_url(parsed.to_string(), None::<&str>)
        .map_err(|error| format!("Windows could not open the source in your default browser: {error}"))
}

pub mod best_source;
