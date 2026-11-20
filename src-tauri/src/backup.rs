//! PR #11 Commit 1: local-only, verifiable backup snapshots.
//! Restore and password-protected archives are deliberately NOT available yet.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use chrono::{Datelike, Duration as ChronoDuration, Local, LocalResult, NaiveTime, TimeZone};
#[cfg(test)]
use chrono::Weekday;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use crate::{app_settings, local_storage::{self, DataPaths, StorageLock}};

const FORMAT: u32 = 1;
const PREFIX: &str = "HavenWalls-";
const SUFFIX: &str = ".hwbackup";
const RETRY_SECONDS: i64 = 15 * 60;

#[derive(Default)]
pub struct BackupGate(pub Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupPreferences {
    pub enabled: bool,
    pub destination: String,
    /// "daily", "weekly", or "interval"
    pub frequency: String,
    pub time: String,
    /// ISO weekday: 1=Monday, 7=Sunday
    pub weekday: u32,
    /// 60 to 10080. 1440 gives a repeating 24-hour interval.
    pub interval_minutes: u32,
    /// "full" or "settings"
    pub backup_type: String,
    pub retention: u32,
}
impl Default for BackupPreferences {
    fn default() -> Self {
        Self {
            enabled: false, destination: String::new(), frequency: "daily".into(),
            time: "02:00".into(), weekday: 7, interval_minutes: 1440,
            backup_type: "full".into(), retention: 3,
        }
    }
}
impl BackupPreferences {
    fn validate(&self) -> Result<(), String> {
        if !["daily", "weekly", "interval"].contains(&self.frequency.as_str()) {
            return Err("Choose daily, weekly or repeating interval backup.".into());
        }
        if NaiveTime::parse_from_str(&self.time, "%H:%M").is_err() ||
            self.time.len() != 5 {
            return Err("Choose a valid 24-hour backup time.".into());
        }
        if !(1..=7).contains(&self.weekday) {
            return Err("Choose a valid weekly backup day.".into());
        }
        if !(60..=10080).contains(&self.interval_minutes) {
            return Err("Backup interval must be 1 to 168 hours.".into());
        }
        if !(1..=30).contains(&self.retention) {
            return Err("Keep between 1 and 30 successful backups.".into());
        }
        if self.backup_type != "full" && self.backup_type != "settings" {
            return Err("Choose Full Library or Settings only.".into());
        }
        if self.enabled && self.destination.trim().is_empty() {
            return Err("Choose a backup folder before enabling automatic backups.".into());
        }
        if self.destination.contains('\0') || self.destination.len() > 2048 {
            return Err("Invalid backup folder path.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    preferences: BackupPreferences,
    next_due_unix: Option<i64>,
    last_success_unix: Option<i64>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    name: String,
    path: String,
    created_unix: i64,
    kind: String,
    bytes: u64,
    file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    preferences: BackupPreferences,
    next_due_unix: Option<i64>,
    last_success_unix: Option<i64>,
    last_error: Option<String>,
    history: Vec<BackupRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    app: String,
    created_unix: i64,
    kind: String,
    files: Vec<ManifestFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_secs() as i64
}
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS backup_settings (
             id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS backup_history (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
             created_unix INTEGER NOT NULL, kind TEXT NOT NULL,
             bytes INTEGER NOT NULL, file_count INTEGER NOT NULL
         );"
    ).map_err(|e| format!("Could not initialize backup settings: {e}"))
}
fn load(conn: &Connection) -> Result<Stored, String> {
    ensure_schema(conn)?;
    let default = serde_json::to_string(&Stored::default()).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO backup_settings(id,json) VALUES(1,?1)", [default])
        .map_err(|e| format!("Could not initialize backup preferences: {e}"))?;
    let json: String = conn.query_row(
        "SELECT json FROM backup_settings WHERE id=1", [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    let stored: Stored = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid saved backup preferences: {e}"))?;
    stored.preferences.validate()?;
    Ok(stored)
}
fn save(conn: &Connection, data: &Stored) -> Result<(), String> {
    data.preferences.validate()?;
    conn.execute("UPDATE backup_settings SET json=?1 WHERE id=1",
        [serde_json::to_string(data).map_err(|e| e.to_string())?])
        .map_err(|e| format!("Could not persist backup preferences: {e}"))?;
    Ok(())
}

fn next_due(reference_unix: i64, prefs: &BackupPreferences) -> i64 {
    if prefs.frequency == "interval" {
        return reference_unix.saturating_add(i64::from(prefs.interval_minutes) * 60);
    }
    let target = NaiveTime::parse_from_str(&prefs.time, "%H:%M")
        .unwrap_or(NaiveTime::MIN);
    let from = Local.timestamp_opt(reference_unix, 0).single()
        .unwrap_or_else(Local::now);
    for offset in 0..=8 {
        let Some(day) = from.date_naive().checked_add_signed(
            ChronoDuration::days(offset)
        ) else { continue };
        if prefs.frequency == "weekly" &&
            day.weekday().number_from_monday() != prefs.weekday { continue; }
        let naive = day.and_time(target);
        let timestamp = match Local.from_local_datetime(&naive) {
            LocalResult::Single(value) => Some(value.timestamp()),
            LocalResult::Ambiguous(a, b) => Some(a.timestamp().min(b.timestamp())),
            LocalResult::None => {
                // DST spring-forward gap: use the earliest valid minute after
                // the requested time on the same day.
                (1..=180).find_map(|minutes| naive.checked_add_signed(
                    ChronoDuration::minutes(minutes)
                ).and_then(|candidate| match Local.from_local_datetime(&candidate) {
                    LocalResult::Single(value) if value.date_naive() == day =>
                        Some(value.timestamp()),
                    LocalResult::Ambiguous(a, _) if a.date_naive() == day =>
                        Some(a.timestamp()),
                    _ => None,
                }))
            }
        };
        if let Some(value) = timestamp {
            if value > reference_unix { return value; }
        }
    }
    reference_unix.saturating_add(86400)
}

fn verify_destination(raw: &str, paths: &DataPaths) -> Result<PathBuf, String> {
    let text = raw.trim();
    if text.is_empty() { return Err("Choose a backup destination folder.".into()); }
    let requested = Path::new(text);
    if !requested.is_absolute() {
        return Err("The backup destination must be an absolute folder path.".into());
    }
    if !requested.is_dir() {
        return Err("Backup folder not found. Create it or connect the drive, then retry.".into());
    }
    let destination = requested.canonicalize()
        .map_err(|e| format!("Could not access backup folder: {e}"))?;
    let root = paths.root.canonicalize()
        .map_err(|e| format!("Could not inspect application storage: {e}"))?;
    if destination.starts_with(&root) {
        return Err("Choose a folder outside Haven Walls application data.".into());
    }
    let meta = fs::symlink_metadata(requested)
        .map_err(|e| format!("Could not inspect backup folder: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("Choose a regular folder, not a linked destination.".into());
    }
    Ok(destination)
}
fn valid_filename(value: &str) -> bool {
    let path = Path::new(value);
    path.components().count() == 1 &&
        matches!(path.components().next(), Some(Component::Normal(_))) &&
        !value.is_empty() && value != "." && value != ".." &&
        !value.contains(['/', '\\', ':', '\0'])
}
fn digest(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| format!("Could not verify backup file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut chunk)
            .map_err(|e| format!("Could not read backup data: {e}"))?;
        if n == 0 { break; }
        hasher.update(&chunk[..n]);
        bytes += n as u64;
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}
fn owned_file(src: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src)
        .map_err(|e| format!("Could not inspect saved wallpaper: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("Saved wallpaper is not a normal file. Backup stopped.".into());
    }
    Ok(())
}
fn record_file(staging: &Path, relative: &str, src: &Path,
               files: &mut Vec<ManifestFile>) -> Result<(), String> {
    owned_file(src)?;
    let target = staging.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create backup folder: {e}"))?;
    }
    fs::copy(src, &target).map_err(|e| format!("Could not copy backup data: {e}"))?;
    let (bytes, sha256) = digest(&target)?;
    let (source_bytes, source_sha256) = digest(src)?;
    if bytes != source_bytes || sha256 != source_sha256 {
        return Err("A file changed while it was being backed up. Previous backups are safe.".into());
    }
    files.push(ManifestFile { path: relative.into(), bytes, sha256 });
    Ok(())
}

fn verify_archive(dir: &Path) -> Result<BackupRecord, String> {
    let manifest_path = dir.join("manifest.json");
    owned_file(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&fs::read(&manifest_path)
        .map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not decode backup manifest: {e}"))?;
    if manifest.format_version != FORMAT || manifest.app != "haven-walls" ||
       !["full", "settings"].contains(&manifest.kind.as_str()) {
        return Err("Unsupported or invalid Haven Walls backup.".into());
    }
    let mut bytes = 0;
    let mut seen = std::collections::HashSet::new();
    for entry in &manifest.files {
        // No arbitrary nested paths, only exact DB or library/filename.
        let safe = entry.path == "haven-walls.sqlite3" ||
            (manifest.kind == "full" && entry.path.starts_with("library/") &&
             valid_filename(&entry.path["library/".len()..]));
        if !safe || !seen.insert(entry.path.clone()) {
            return Err("Unexpected or duplicated backup file path.".into());
        }
        let file = dir.join(&entry.path);
        owned_file(&file)?;
        let (length, checksum) = digest(&file)?;
        if length != entry.bytes || checksum != entry.sha256 {
            return Err("Backup verification failed: a file does not match its checksum.".into());
        }
        bytes += length;
    }
    if !seen.contains("haven-walls.sqlite3") {
        return Err("Backup is missing its database snapshot.".into());
    }
    let snapshot = Connection::open_with_flags(dir.join("haven-walls.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Could not open backup database: {e}"))?;
    let integrity: String = snapshot.query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("Could not verify backup database: {e}"))?;
    if integrity != "ok" { return Err("Backup database failed integrity verification.".into()); }
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    Ok(BackupRecord {
        name, path: dir.display().to_string(), created_unix: manifest.created_unix,
        kind: manifest.kind, bytes, file_count: manifest.files.len(),
    })
}

fn list_history(conn: &Connection) -> Result<Vec<BackupRecord>, String> {
    let mut stmt = conn.prepare(
        "SELECT name, path, created_unix, kind, bytes, file_count
         FROM backup_history ORDER BY created_unix DESC, id DESC LIMIT 20"
    ).map_err(|e| e.to_string())?;
    // SQLite INTEGER values are signed i64. rusqlite cannot deserialize
    // straight into u64 or usize, so check the range before converting.
    let rows = stmt.query_map([], |r| {
        let bytes: i64 = r.get(4)?;
        let file_count: i64 = r.get(5)?;
        Ok(BackupRecord {
            name: r.get(0)?, path: r.get(1)?, created_unix: r.get(2)?,
            kind: r.get(3)?,
            bytes: u64::try_from(bytes)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, bytes))?,
            file_count: usize::try_from(file_count)
                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, file_count))?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
fn status(conn: &Connection) -> Result<BackupStatus, String> {
    let data = load(conn)?;
    Ok(BackupStatus {
        preferences: data.preferences, next_due_unix: data.next_due_unix,
        last_success_unix: data.last_success_unix, last_error: data.last_error,
        history: list_history(conn)?,
    })
}
fn with_db<T>(app: &AppHandle,
    f: impl FnOnce(&Connection, &DataPaths) -> Result<T, String>,
) -> Result<T, String> {
    let lock = app.state::<StorageLock>();
    let _guard = lock.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    f(&conn, &paths)
}

/// Protect unrelated content: only directories matching our generated naming
/// convention AND holding a matching Haven Walls manifest can be pruned.
fn prune(destination: &Path, retention: u32) -> Result<Vec<String>, String> {
    let mut backups = Vec::new();
    for entry in fs::read_dir(destination).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(PREFIX) || !name.ends_with(SUFFIX) { continue; }
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() { continue; }
        let manifest_file = entry.path().join("manifest.json");
        let Ok(manifest_data) = fs::read(&manifest_file) else { continue };
        let Ok(manifest) = serde_json::from_slice::<Manifest>(&manifest_data) else { continue };
        if manifest.app != "haven-walls" || manifest.format_version != FORMAT { continue; }
        backups.push((name, entry.path()));
    }
    backups.sort_by(|a,b| b.0.cmp(&a.0));
    let mut deleted = Vec::new();
    for (_, path) in backups.into_iter().skip(retention as usize) {
        // This only runs AFTER the new snapshot has passed full checksum and
        // SQLite verification. Older entries were identified by a valid Haven
        // Walls manifest above; avoid re-reading gigabytes of old images.
        fs::remove_dir_all(&path).map_err(|e|
            format!("Backup saved, but old backups could not be removed: {e}"))?;
        deleted.push(path.display().to_string());
    }
    Ok(deleted)
}

fn create_snapshot(conn: &Connection, paths: &DataPaths,
                   prefs: &BackupPreferences) -> Result<BackupRecord, String> {
    prefs.validate()?;
    let destination = verify_destination(&prefs.destination, paths)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let name = format!("{PREFIX}{stamp:020}-{}{SUFFIX}", prefs.backup_type);
    let staging = destination.join(format!(".havenwalls-staging-{stamp:020}"));
    let final_path = destination.join(name);
    if staging.exists() || final_path.exists() {
        return Err("Backup name collision. Retry the operation.".into());
    }
    fs::create_dir(&staging)
        .map_err(|e| format!("Cannot write to the selected backup folder: {e}"))?;
    let build = (|| {
        let db_path = staging.join("haven-walls.sqlite3");
        conn.execute("VACUUM INTO ?1", [db_path.to_string_lossy().as_ref()])
            .map_err(|e| format!("Could not create consistent SQLite snapshot: {e}"))?;
        // Credential ciphertext is Windows-user-bound and must NOT be shipped
        // in either backup type. Clear it in the COPY, never the live DB.
        let snapshot = Connection::open(&db_path).map_err(|e| e.to_string())?;
        snapshot.execute("DELETE FROM api_credentials", [])
            .map_err(|e| format!("Could not remove API keys from backup: {e}"))?;
        // A DELETE alone can leave ciphertext in SQLite free pages.
        // Rewrite the sanitized COPY to discard those pages too.
        snapshot.execute_batch("VACUUM;")
            .map_err(|e| format!("Could not sanitize backup database: {e}"))?;
        drop(snapshot);
        let mut files = Vec::new();
        let (db_bytes, db_sha) = digest(&db_path)?;
        files.push(ManifestFile {
            path: "haven-walls.sqlite3".into(), bytes: db_bytes, sha256: db_sha,
        });
        if prefs.backup_type == "full" {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT relative_path FROM wallpaper_files
                 WHERE storage_class='managed' ORDER BY relative_path"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let filename = row.map_err(|e| e.to_string())?;
                if !valid_filename(&filename) {
                    return Err("Library contains an invalid relative file name.".into());
                }
                record_file(&staging, &format!("library/{filename}"),
                    &paths.library().join(filename), &mut files)?;
            }
        }
        let manifest = Manifest {
            format_version: FORMAT, app: "haven-walls".into(),
            created_unix: now(), kind: prefs.backup_type.clone(), files,
        };
        let data = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        let mut f = File::create(staging.join("manifest.json"))
            .map_err(|e| format!("Could not write backup manifest: {e}"))?;
        f.write_all(&data).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        let _verified = verify_archive(&staging)?;
        fs::rename(&staging, &final_path)
            .map_err(|e| format!("Could not finalize verified backup: {e}"))?;
        verify_archive(&final_path)
    })();
    if build.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    build
}

fn perform(app: &AppHandle, automatic: bool) -> Result<BackupStatus, String> {
    let gate = app.state::<BackupGate>();
    let _gate = gate.0.lock().map_err(|_| "Another backup is running.".to_string())?;
    with_db(app, |conn, paths| {
        let mut state = load(conn)?;
        if automatic {
            if !state.preferences.enabled ||
               state.next_due_unix.map(|due| due > now()).unwrap_or(true) {
                return status(conn);
            }
        }
        let result = create_snapshot(conn, paths, &state.preferences);
        match result {
            Ok(record) => {
                conn.execute(
                    "INSERT INTO backup_history(name,path,created_unix,kind,bytes,file_count)
                     VALUES(?1,?2,?3,?4,?5,?6)",
                    params![record.name, record.path, record.created_unix, record.kind,
                        i64::try_from(record.bytes).map_err(|_| "Backup size exceeds SQLite INTEGER range.")?,
                        i64::try_from(record.file_count).map_err(|_| "Backup file count exceeds SQLite INTEGER range.")?],
                ).map_err(|e| format!("Backup saved but history update failed: {e}"))?;
                if automatic {
                    state.next_due_unix = Some(next_due(now(), &state.preferences));
                }
                state.last_success_unix = Some(now());
                state.last_error = None;
                save(conn, &state)?;
                // Prune only after a verified commit AND a persisted record.
                let dest = verify_destination(&state.preferences.destination, paths)?;
                match prune(&dest, state.preferences.retention) {
                    Ok(deleted) => {
                        for path in deleted {
                            conn.execute("DELETE FROM backup_history WHERE path=?1", [path])
                                .map_err(|e| format!("Could not update backup history: {e}"))?;
                        }
                    }
                    Err(warning) => {
                        state.last_error = Some(warning);
                        save(conn, &state)?;
                    }
                }
                status(conn)
            }
            Err(problem) => {
                state.last_error = Some(problem.clone());
                if automatic {
                    state.next_due_unix = Some(now().saturating_add(RETRY_SECONDS));
                }
                save(conn, &state)?;
                Err(problem)
            }
        }
    })
}

#[tauri::command]
pub fn get_backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    with_db(&app, |conn, _| status(conn))
}
#[tauri::command]
pub fn save_backup_preferences(app: AppHandle,
    preferences: BackupPreferences) -> Result<BackupStatus, String> {
    preferences.validate()?;
    let gate = app.state::<BackupGate>();
    let _gate = gate.0.lock().map_err(|_| "Backup is running.".to_string())?;
    with_db(&app, |conn, paths| {
        // Users must be able to disable scheduling even when a previously
        // selected USB or network drive is currently disconnected.
        if preferences.enabled {
            verify_destination(&preferences.destination, paths)?;
        }
        let mut state = load(conn)?;
        let previous = state.preferences.clone();
        if !preferences.enabled {
            state.next_due_unix = None;
        } else if !previous.enabled || previous.frequency != preferences.frequency ||
            previous.weekday != preferences.weekday || previous.time != preferences.time ||
            previous.interval_minutes != preferences.interval_minutes {
            state.next_due_unix = Some(next_due(now(), &preferences));
        } else if state.next_due_unix.is_none() {
            state.next_due_unix = Some(next_due(now(), &preferences));
        }
        state.preferences = preferences;
        state.last_error = None;
        save(conn, &state)?;
        status(conn)
    })
}
#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Result<BackupStatus, String> {
    tauri::async_runtime::spawn_blocking(move || perform(&app, false))
        .await.map_err(|_| "Backup worker was interrupted.".to_string())?
}

/// The folder picker uses a dedicated STA thread so it remains usable even
/// if Tauri invokes this command from an MTA thread. No new plugin needed.
#[tauri::command]
pub async fn choose_backup_folder() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(native_folder_picker)
            .await.map_err(|_| "Folder picker was interrupted.".to_string())?
    }
    #[cfg(not(windows))]
    { Err("Folder selection is supported in the Windows app.".into()) }
}

#[cfg(windows)]
fn native_folder_picker() -> Result<Option<String>, String> {
    std::thread::spawn(|| {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{
            FileOpenDialog, IFileOpenDialog, FOS_PICKFOLDERS,
            FOS_FORCEFILESYSTEM, SIGDN_FILESYSPATH,
        };
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()
                .map_err(|e| format!("Could not initialize folder picker: {e}"))?;
            let result = (|| {
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| format!("Could not open folder picker: {e}"))?;
                let options = dialog.GetOptions().map_err(|e| e.to_string())?;
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)
                    .map_err(|e| e.to_string())?;
                if let Err(error) = dialog.Show(None) {
                    // HRESULT_FROM_WIN32(ERROR_CANCELLED)
                    if error.code().0 == 0x800704C7u32 as i32 { return Ok(None); }
                    return Err(format!("Folder picker failed: {error}"));
                }
                let item = dialog.GetResult().map_err(|e| e.to_string())?;
                let path = item.GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|e| e.to_string())?;
                let value = path.to_string().map_err(|e| e.to_string());
                CoTaskMemFree(Some(path.0.cast()));
                value.map(Some)
            })();
            CoUninitialize();
            result
        }
    }).join().map_err(|_| "Folder picker thread failed.".to_string())?
}

/// Runs in the native process, including when the Settings window is closed.
/// No backlog of missed jobs is replayed after sleep or a restart.
pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("haven-backup".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let _ = with_db(&app, |conn, _| {
                let mut state = load(conn)?;
                if state.preferences.enabled && state.next_due_unix.is_none() {
                    state.next_due_unix = Some(next_due(now(), &state.preferences));
                    save(conn, &state)?;
                }
                Ok(())
            });
            let _ = perform(&app, true);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_opt_in_and_require_a_destination() {
        let mut p = BackupPreferences::default();
        assert!(!p.enabled);
        assert_eq!(p.retention, 3);
        p.enabled = true;
        assert!(p.validate().is_err());
        p.destination = "C:\\HavenWallsBackups".into();
        assert!(p.validate().is_ok());
        p.interval_minutes = 59;
        assert!(p.validate().is_err());
        p.interval_minutes = 1440;
        p.retention = 31;
        assert!(p.validate().is_err());
    }
    #[test]
    fn intervals_and_fixed_schedules_are_future_dated() {
        let baseline = now();
        let mut p = BackupPreferences::default();
        p.frequency = "interval".into();
        assert_eq!(next_due(baseline, &p), baseline + 86400);
        p.frequency = "daily".into();
        let next = next_due(baseline, &p);
        assert!(next > baseline && next <= baseline + 90000);
        p.frequency = "weekly".into();
        let next = next_due(baseline, &p);
        assert!(next > baseline && next <= baseline + 8*86400);
        let day = Local.timestamp_opt(next, 0).single().unwrap().weekday();
        assert_eq!(day, Weekday::Sun);
    }
    #[test]
    fn filenames_cannot_escape_the_archive() {
        assert!(valid_filename("image-123.webp"));
        for value in ["", ".", "..", "../secret", "foo/bar", "foo\\bar", "foo\\bar/../../etc"] {
            assert!(!valid_filename(value));
        }
    }
    #[test]
    fn full_backup_is_verified_sanitized_and_previous_backup_is_retained_until_new_one() {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let sandbox = std::env::temp_dir().join(
            format!("haven-backup-test-{}-{id}", std::process::id()));
        let paths = DataPaths {
            root: sandbox.join("data"),
            mode: local_storage::StorageMode::AppData,
        };
        local_storage::prepare_folders(&paths).unwrap();
        let destination = sandbox.join("backups");
        fs::create_dir_all(&destination).unwrap();
        let conn = app_settings::open_database(&paths).unwrap();
        load(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO wallpapers(id,title,source,width,height)
             VALUES('example','Example','import',2560,1440);
             INSERT INTO wallpaper_files(
               id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
             VALUES('file','example','example.jpg','managed',6,'placeholder');
             INSERT INTO api_credentials(provider,ciphertext)
             VALUES('tmdb',X'0102030405');"
        ).unwrap();
        fs::write(paths.library().join("example.jpg"), b"abc123").unwrap();
        let mut prefs = BackupPreferences::default();
        prefs.destination = destination.display().to_string();
        let first = create_snapshot(&conn, &paths, &prefs).unwrap();
        assert_eq!(first.file_count, 2);
        assert!(Path::new(&first.path).join("library/example.jpg").exists());
        let snap = Connection::open(Path::new(&first.path)
            .join("haven-walls.sqlite3")).unwrap();
        let credentials: i64 = snap.query_row(
            "SELECT COUNT(*) FROM api_credentials", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(credentials, 0);
        assert_eq!(conn.query_row(
            "SELECT COUNT(*) FROM api_credentials", [], |r| r.get::<_, i64>(0)
        ).unwrap(), 1); // Live credentials are never modified.
        drop(snap);
        let second = create_snapshot(&conn, &paths, &prefs).unwrap();
        assert!(Path::new(&first.path).exists()); // Never prune before success.
        assert!(Path::new(&second.path).exists());
        let removed = prune(&destination, 1).unwrap();
        assert_eq!(removed.len(), 1);
        assert!(!Path::new(&first.path).exists());
        assert!(verify_archive(Path::new(&second.path)).is_ok());
        // A corrupted backup cannot be treated as verified.
        fs::write(Path::new(&second.path).join("library/example.jpg"), b"changed").unwrap();
        assert!(verify_archive(Path::new(&second.path)).is_err());
        drop(conn);
        fs::remove_dir_all(sandbox).unwrap();
    }
    #[test]
    fn settings_only_does_not_copy_library_bytes() {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let sandbox = std::env::temp_dir().join(
            format!("haven-backup-settings-{}-{id}", std::process::id()));
        let paths = DataPaths {
            root: sandbox.join("data"),
            mode: local_storage::StorageMode::AppData,
        };
        local_storage::prepare_folders(&paths).unwrap();
        let destination = sandbox.join("backups");
        fs::create_dir_all(&destination).unwrap();
        let conn = app_settings::open_database(&paths).unwrap();
        let mut prefs = BackupPreferences::default();
        prefs.backup_type = "settings".into();
        prefs.destination = destination.display().to_string();
        let record = create_snapshot(&conn, &paths, &prefs).unwrap();
        assert_eq!(record.file_count, 1);
        assert!(!Path::new(&record.path).join("library").exists());
        assert!(verify_archive(Path::new(&record.path)).is_ok());
        drop(conn);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[test]
    fn backup_history_reads_signed_sqlite_integers_as_safe_unsigned_counts() {
        let conn = Connection::open_in_memory().unwrap();
        load(&conn).unwrap();
        conn.execute(
            "INSERT INTO backup_history(name,path,created_unix,kind,bytes,file_count)
             VALUES('test','C:/test.hwbackup',12345,'full',4096,3)",
            [],
        ).unwrap();
        let history = list_history(&conn).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].bytes, 4096_u64);
        assert_eq!(history[0].file_count, 3_usize);

        // Reject malformed negative database values instead of wrapping them.
        conn.execute(
            "UPDATE backup_history SET bytes=-1 WHERE name='test'",
            [],
        ).unwrap();
        assert!(list_history(&conn).is_err());
    }

    #[test]
    fn durable_config_roundtrip_preserves_schedule() {
        let conn = Connection::open_in_memory().unwrap();
        let mut saved = load(&conn).unwrap();
        saved.preferences.destination = "D:\\Backups".into();
        saved.preferences.enabled = true;
        saved.next_due_unix = Some(123);
        save(&conn, &saved).unwrap();
        let loaded = load(&conn).unwrap();
        assert_eq!(loaded.preferences, saved.preferences);
        assert_eq!(loaded.next_due_unix, Some(123));
    }
}
