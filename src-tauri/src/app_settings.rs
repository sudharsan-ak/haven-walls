//! SQLite schema and validated local application preferences.
//! The database is the canonical source for settings and later library records.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::local_storage::DataPaths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub wallpaper_fit: String,
    pub minimum_resolution: String,
    pub prefer_4k: bool,
    pub show_photo_credit: bool,
    pub show_caption: bool,
    /// When enabled, a user-driven Add to Library begins without another
    /// rights checkbox. This is NOT a claim of a verified image license.
    pub skip_import_confirmation: bool,
    pub cache_limit_mb: u32,
    pub duplicate_sensitivity: u8,
    pub allowed_image_types: Vec<String>,
    pub excluded_keywords: Vec<String>,
    pub excluded_sources: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            wallpaper_fit: "smartFit".into(),
            minimum_resolution: "1080p".into(),
            prefer_4k: true,
            show_photo_credit: true,
            show_caption: false,
            skip_import_confirmation: true,
            cache_limit_mb: 2048,
            duplicate_sensitivity: 70,
            allowed_image_types: vec!["jpg".into(), "png".into(), "webp".into()],
            excluded_keywords: vec![],
            excluded_sources: vec![],
        }
    }
}

impl AppSettings {
    pub fn validate(&mut self) -> Result<(), String> {
        if !["smartFit", "fill", "fit", "stretch", "center", "span"]
            .contains(&self.wallpaper_fit.as_str())
        {
            return Err("Choose a supported Windows wallpaper fit mode.".into());
        }
        if !["1080p", "1440p", "4K"].contains(&self.minimum_resolution.as_str()) {
            return Err("Choose a minimum resolution of 1080p, 1440p or 4K.".into());
        }
        if !(128..=20480).contains(&self.cache_limit_mb) {
            return Err("Cache limit must be between 128 MB and 20 GB.".into());
        }
        if self.duplicate_sensitivity > 100 {
            return Err("Duplicate similarity sensitivity must be between 0 and 100.".into());
        }
        self.allowed_image_types.sort();
        self.allowed_image_types.dedup();
        if self.allowed_image_types.is_empty() ||
            self.allowed_image_types.iter().any(|extension|
                !["jpg", "png", "webp"].contains(&extension.as_str()))
        {
            return Err("Allow at least one supported image type (JPG, PNG, WebP).".into());
        }
        normalize_exclusions(&mut self.excluded_keywords, "keyword")?;
        normalize_exclusions(&mut self.excluded_sources, "source")?;
        Ok(())
    }
}

fn normalize_exclusions(items: &mut Vec<String>, kind: &str) -> Result<(), String> {
    if items.len() > 100 {
        return Err(format!("Keep the {kind} exclusion list under 100 entries."));
    }
    let mut cleaned: Vec<String> = Vec::new();
    for text in items.iter() {
        let text = text.trim();
        if text.is_empty() { continue; }
        if text.chars().count() > 140 || text.contains('\0') {
            return Err(format!("A {kind} exclusion is too long or contains invalid characters."));
        }
        if !cleaned.iter().any(|existing| existing.eq_ignore_ascii_case(text)) {
            cleaned.push(text.to_owned());
        }
    }
    *items = cleaned;
    Ok(())
}

pub fn open_database(paths: &DataPaths) -> Result<Connection, String> {
    let conn = Connection::open(paths.database())
        .map_err(|e| format!("Could not open Haven Walls database: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Could not configure database timeout: {e}"))?;
    let schema_version: u32 = conn.query_row(
        "PRAGMA user_version", [], |row| row.get(0)
    ).map_err(|e| format!("Could not read database version: {e}"))?;
    if schema_version > 1 {
        return Err("This Haven Walls database was created by a newer version of the app.             It will not be opened with an older schema.".into());
    }
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=DELETE;
         CREATE TABLE IF NOT EXISTS app_settings (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS wallpapers (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           source TEXT NOT NULL,
           source_page TEXT,
           original_url TEXT,
           creator TEXT,
           rights_status TEXT NOT NULL DEFAULT 'unverified',
           width INTEGER NOT NULL,
           height INTEGER NOT NULL,
           checksum_sha256 TEXT,
           favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS wallpaper_files (
           id TEXT PRIMARY KEY,
           wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE CASCADE,
           relative_path TEXT NOT NULL,
           storage_class TEXT NOT NULL CHECK (
             storage_class IN ('discovery','pending','managed','reserve','active')
           ),
           bytes INTEGER NOT NULL CHECK (bytes >= 0),
           checksum_sha256 TEXT NOT NULL,
           UNIQUE(storage_class, relative_path)
         );
         CREATE TABLE IF NOT EXISTS categories (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           parent_id TEXT REFERENCES categories(id)
         );
         CREATE TABLE IF NOT EXISTS wallpaper_categories (
           wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE CASCADE,
           category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
           PRIMARY KEY (wallpaper_id, category_id)
         );
         CREATE TABLE IF NOT EXISTS wallpaper_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           wallpaper_id TEXT REFERENCES wallpapers(id) ON DELETE SET NULL,
           target_id TEXT NOT NULL DEFAULT 'all',
           action TEXT NOT NULL,
           event_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           detail TEXT
         );
         CREATE INDEX IF NOT EXISTS ix_files_wallpaper ON wallpaper_files(wallpaper_id);
         CREATE INDEX IF NOT EXISTS ix_events_time ON wallpaper_events(event_time DESC);
         PRAGMA user_version=1;"
    ).map_err(|e| format!("Could not initialize Haven Walls database: {e}"))?;

    // Read and write settings in the same canonical DB as the future library.
    let json = serde_json::to_string(&AppSettings::default())
        .map_err(|e| format!("Could not prepare default settings: {e}"))?;
    conn.execute("INSERT OR IGNORE INTO app_settings (id, json) VALUES (1, ?1)",
        params![json])
        .map_err(|e| format!("Could not save initial settings: {e}"))?;
    Ok(conn)
}

pub fn read_settings(conn: &Connection) -> Result<AppSettings, String> {
    let json: String = conn.query_row(
        "SELECT json FROM app_settings WHERE id=1", [],
        |row| row.get(0)
    ).map_err(|e| format!("Could not read settings: {e}"))?;
    let mut result: AppSettings = serde_json::from_str(&json)
        .map_err(|e| format!("Saved settings could not be decoded: {e}"))?;
    result.validate()?;
    Ok(result)
}

pub fn save_settings(conn: &Connection, mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.validate()?;
    let json = serde_json::to_string(&settings)
        .map_err(|e| format!("Could not encode settings: {e}"))?;
    conn.execute("UPDATE app_settings SET json=?1 WHERE id=1", params![json])
        .map_err(|e| format!("Could not save settings: {e}"))?;
    Ok(settings)
}
