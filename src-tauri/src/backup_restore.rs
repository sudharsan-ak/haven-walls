//! PR #11 Commit 2: verified, recoverable import of Haven Walls snapshots.
//! Never replace the live SQLite file or current OS wallpaper in-place.
use std::{collections::HashSet, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use crate::{app_settings, backup::{self, BackupGate, Manifest},
            local_storage::{self, DataPaths, StorageLock}};

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct RestorePreview {
    backup_path: String,
    manifest_hash: String,
    created_unix: i64,
    kind: String,
    bytes: u64,
    image_count: usize,
    category_count: i64,
    collection_count: i64,
    interest_count: i64,
    warning: String,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct RestoreResult {
    mode: String,
    kind: String,
    restored_images: usize,
    recovery_path: String,
    notice: String,
}

fn error(problem: rusqlite::Error) -> String { problem.to_string() }

/// Only folders, not arbitrary files or symlinks. A folder is treated as
/// untrusted input, and its manifest, hashes and schema are rechecked.
fn backup_folder(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() { return Err("Choose a Haven Walls backup folder.".into()); }
    let path = Path::new(raw);
    if !path.is_absolute() { return Err("Choose an absolute backup folder path.".into()); }
    if fs::symlink_metadata(path).map_err(|e| format!("Could not inspect backup: {e}"))?
        .file_type().is_symlink() {
        return Err("Linked backup folders are not accepted.".into());
    }
    let canonical = path.canonicalize()
        .map_err(|e| format!("Backup folder cannot be opened: {e}"))?;
    if !canonical.is_dir() {
        return Err("Choose the .hwbackup folder, not a file.".into());
    }
    if !canonical.file_name().unwrap_or_default().to_string_lossy().ends_with(".hwbackup") {
        return Err("Choose a Haven Walls .hwbackup folder.".into());
    }
    Ok(canonical)
}

fn open_source(folder: &Path) -> Result<Connection, String> {
    let source = Connection::open_with_flags(folder.join("haven-walls.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Cannot inspect backed-up database: {e}"))?;
    let version: i64 = source.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(error)?;
    if !(3..=3).contains(&version) {
        return Err("This backup uses an unsupported database schema version.".into());
    }
    let foreign_key_problem = source.prepare("PRAGMA foreign_key_check")
        .map_err(error)?.exists([]).map_err(error)?;
    if foreign_key_problem {
        return Err("Backup database contains broken relationships.".into());
    }
    Ok(source)
}
fn table_count(conn: &Connection, table: &str) -> Result<i64, String> {
    // Never use arbitrary table identifiers from the selected backup.
    let sql = match table {
        "categories" => "SELECT COUNT(*) FROM categories",
        "collections" => "SELECT COUNT(*) FROM collections",
        "followed_interests" => "SELECT COUNT(*) FROM followed_interests",
        "managed" => "SELECT COUNT(DISTINCT relative_path) FROM wallpaper_files WHERE storage_class='managed'",
        _ => return Err("Unsupported preview table.".into()),
    };
    conn.query_row(sql, [], |r| r.get(0)).map_err(error)
}
fn manifest_fingerprint(folder: &Path) -> Result<String, String> {
    let bytes = fs::read(folder.join("manifest.json"))
        .map_err(|e| format!("Cannot read backup manifest: {e}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn verified(folder: &Path) -> Result<(Manifest, RestorePreview), String> {
    let record = backup::verify_archive(folder)?;
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(folder.join("manifest.json")).map_err(|e| e.to_string())?
    ).map_err(|e| format!("Invalid backup manifest: {e}"))?;
    let source = open_source(folder)?;
    let count = table_count(&source, "managed")?;
    if manifest.kind == "full" {
        let mut names = HashSet::new();
        for file in &manifest.files {
            if let Some(name) = file.path.strip_prefix("library/") {
                names.insert(name.to_owned());
            }
        }
        let mut stmt = source.prepare(
            "SELECT DISTINCT relative_path FROM wallpaper_files
             WHERE storage_class='managed'"
        ).map_err(error)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(error)?;
        let listed = rows.collect::<Result<HashSet<_>, _>>().map_err(error)?;
        if names != listed || count != names.len() as i64 {
            return Err("Backup files do not match the saved Library database.".into());
        }
    }
    let preview = RestorePreview {
        backup_path: folder.display().to_string(),
        manifest_hash: manifest_fingerprint(folder)?,
        created_unix: record.created_unix, kind: manifest.kind.clone(),
        bytes: record.bytes,
        image_count: if manifest.kind == "full" { count as usize } else { 0 },
        category_count: table_count(&source, "categories")?,
        collection_count: table_count(&source, "collections")?,
        interest_count: table_count(&source, "followed_interests")?,
        warning: if manifest.kind == "settings" {
            "Settings-only backups do not contain image files. Merge preserves your current app, rotation and background settings while adding missing organization data. Replace restores backed-up settings without removing existing Library images.".into()
        } else {
            "Merge adds missing saved Library data and interests, keeping existing favorite choices and app, rotation and background settings unchanged. Replace restores saved settings and managed Library records. Your active Windows wallpaper, offline reserve and current API credentials stay untouched. A recovery snapshot is created first.".into()
        },
    };
    Ok((manifest, preview))
}
#[tauri::command]
pub async fn preview_backup_restore(path: String) -> Result<RestorePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = backup_folder(&path)?;
        verified(&folder).map(|(_, preview)| preview)
    }).await.map_err(|_| "Backup inspection was interrupted.".to_string())?
}

/// Prevent silent overwrites when a local managed file has the same filename
/// but different bytes. In that case the user can restore to a fresh profile.
fn stage_files(manifest: &Manifest, folder: &Path, paths: &DataPaths)
    -> Result<(PathBuf, Vec<(PathBuf, PathBuf)>), String> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let staging = paths.root.join(format!(".restore-stage-{nonce}"));
    fs::create_dir(&staging)
        .map_err(|e| format!("Could not stage restored images: {e}"))?;
    let work = (|| {
        let mut pending = Vec::new();
        for entry in &manifest.files {
            let Some(filename) = entry.path.strip_prefix("library/") else { continue };
            let original = folder.join(&entry.path);
            let destination = paths.library().join(filename);
            if destination.exists() {
                let metadata = fs::symlink_metadata(&destination)
                    .map_err(|e| format!("Could not inspect existing image: {e}"))?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err("An existing Library path is not a regular file. Restore stopped.".into());
                }
                let checksum = file_checksum(&destination)?;
                if checksum != entry.sha256 {
                    return Err(format!(
                        "Library image filename conflict: {filename}. Existing file was not overwritten."
                    ));
                }
                continue;
            }
            let temporary = staging.join(filename);
            fs::copy(&original, &temporary).map_err(|e|
                format!("Could not stage restored Library image: {e}"))?;
            if file_checksum(&temporary)? != entry.sha256 {
                return Err("A restored Library image changed during copying.".into());
            }
            pending.push((temporary, destination));
        }
        Ok(pending)
    })();
    if work.is_err() { let _ = fs::remove_dir_all(&staging); }
    work.map(|pending| (staging, pending))
}
fn file_checksum(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64*1024];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn attached_table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    // Known table names only. Never interpolate user-supplied identifiers.
    if !["background_preferences", "rotation_settings",
          "wallpaper_fingerprints", "browser_bookmarks"].contains(&table) {
        return Err("Unsupported restored settings table.".into());
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM restore_source.sqlite_master
         WHERE type='table' AND name=?1)",
        [table], |row| row.get::<_, i64>(0),
    ).map(|v| v != 0).map_err(error)
}

/// All SQL runs inside a single transaction; it never replaces live SQLite
/// files or the live Windows wallpaper. Full Replace affects the *managed*
/// Library, not reserve, active assignments or arbitrary external originals.
fn import_sql(conn: &Connection, mode: &str, kind: &str, prefix: &str)
    -> Result<(), String> {
    let full = kind == "full";
    if mode == "merge" || !full {
        // A source identifier pointing to a different existing category or
        // collection must not silently reassign somebody else's images.
        let collision: i64 = conn.query_row(
            "SELECT COUNT(*) FROM restore_source.categories s JOIN main.categories m
             ON s.id=m.id WHERE s.name<>m.name COLLATE NOCASE", [], |r| r.get(0),
        ).map_err(error)?;
        let collection_collision: i64 = conn.query_row(
            "SELECT COUNT(*) FROM restore_source.collections s JOIN main.collections m
             ON s.id=m.id WHERE s.name<>m.name COLLATE NOCASE", [], |r| r.get(0),
        ).map_err(error)?;
        if collision != 0 || collection_collision != 0 {
            return Err("Collection or category IDs conflict with your current Library. Use Replace after reviewing the preview, or import into a fresh profile.".into());
        }
    }
    // Settings-only Replace is deliberately non-destructive to the Library.
    // Existing category/collection relationships are never removed when the
    // backup contains no actual managed image files.
    if mode == "replace" && full {
        conn.execute_batch(
            "DELETE FROM wallpaper_categories;
             DELETE FROM wallpaper_collections;
             UPDATE categories SET parent_id=NULL;
             DELETE FROM categories;
             DELETE FROM collections;
             DELETE FROM wallpaper_files WHERE storage_class='managed';
             CREATE TABLE IF NOT EXISTS active_assignments (
               target_id TEXT PRIMARY KEY,
               wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE RESTRICT,
               relative_path TEXT NOT NULL,
               applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             DELETE FROM wallpapers
               WHERE NOT EXISTS(SELECT 1 FROM wallpaper_files f WHERE f.wallpaper_id=wallpapers.id)
                 AND NOT EXISTS(SELECT 1 FROM active_assignments a WHERE a.wallpaper_id=wallpapers.id);"
        ).map_err(error)?;
    }
    // Parent relationships are set in a second pass to allow out-of-order
    // category rows. Existing parent relationships survive Merge.
    conn.execute_batch(
        "CREATE TEMP TABLE restore_new_categories AS
           SELECT id FROM restore_source.categories
           WHERE id NOT IN (SELECT id FROM main.categories);
         INSERT OR IGNORE INTO categories(id,name,parent_id)
           SELECT id,name,NULL FROM restore_source.categories;
         UPDATE categories SET parent_id=(
           SELECT s.parent_id FROM restore_source.categories s
           WHERE s.id=categories.id
         ) WHERE id IN (SELECT id FROM restore_new_categories);
         DROP TABLE restore_new_categories;
         INSERT OR IGNORE INTO collections(id,name,created_at)
           SELECT id,name,created_at FROM restore_source.collections;
         CREATE TEMP TABLE restore_collection_map AS
           SELECT s.id AS source_id,
             (SELECT c.id FROM main.collections c
              WHERE c.name=s.name COLLATE NOCASE LIMIT 1) AS target_id
           FROM restore_source.collections s;"
    ).map_err(error)?;
    // A same-named collection can retain its existing ID in Merge, and
    // restored wallpaper memberships are mapped to that existing ID.
    let missing_map: i64 = conn.query_row(
        "SELECT COUNT(*) FROM restore_collection_map WHERE target_id IS NULL",
        [], |r| r.get(0),
    ).map_err(error)?;
    if missing_map != 0 { return Err("Could not reconcile restored collection names.".into()); }

    if mode == "replace" {
        conn.execute_batch("DELETE FROM followed_interests;").map_err(error)?;
    }
    // With Merge, identical provider identities are preserved as one follow.
    // Avoid silently ignoring an ID that identifies a different source.
    let bad_interest: i64 = conn.query_row(
        "SELECT COUNT(*) FROM restore_source.followed_interests s
         JOIN main.followed_interests m ON m.id=s.id
         WHERE m.kind<>s.kind OR m.provider<>s.provider OR m.provider_id<>s.provider_id",
        [], |r| r.get(0),
    ).map_err(error)?;
    if bad_interest != 0 {
        return Err("A saved interest has a conflicting identifier. No data was changed.".into());
    }
    conn.execute_batch(
        "INSERT OR IGNORE INTO followed_interests
           (id,kind,provider,provider_id,title,parent_id,preferences_json,created_at)
         SELECT id,kind,provider,provider_id,title,parent_id,preferences_json,created_at
         FROM restore_source.followed_interests;"
    ).map_err(error)?;

    if full {
        conn.execute_batch(
            "INSERT OR IGNORE INTO wallpapers
               (id,title,source,source_page,original_url,creator,rights_status,
                width,height,checksum_sha256,favorite,created_at)
             SELECT w.id,w.title,w.source,w.source_page,w.original_url,w.creator,
                    w.rights_status,w.width,w.height,w.checksum_sha256,w.favorite,w.created_at
             FROM restore_source.wallpapers w WHERE EXISTS(
               SELECT 1 FROM restore_source.wallpaper_files f
               WHERE f.wallpaper_id=w.id AND f.storage_class='managed'
             );"
        ).map_err(error)?;
        // INSERT OR IGNORE above preserves local favorites on existing
        // wallpapers. Merge adds new favorites from the backup only for
        // wallpapers that were not already in the Library.
        conn.execute(
            "INSERT OR IGNORE INTO wallpaper_files
               (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
             SELECT ?1 || f.id,f.wallpaper_id,f.relative_path,f.storage_class,
                    f.bytes,f.checksum_sha256
             FROM restore_source.wallpaper_files f
             WHERE f.storage_class='managed'",
            params![prefix],
        ).map_err(error)?;
        let absent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM restore_source.wallpaper_files s
             WHERE s.storage_class='managed' AND NOT EXISTS(
               SELECT 1 FROM main.wallpaper_files f
               WHERE f.storage_class='managed' AND f.relative_path=s.relative_path
                     AND f.wallpaper_id=s.wallpaper_id
             )", [], |r| r.get(0),
        ).map_err(error)?;
        if absent != 0 {
            return Err("Restored wallpaper metadata conflicts with existing Library entries.".into());
        }
        if attached_table_exists(conn, "wallpaper_fingerprints")? {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS wallpaper_fingerprints (
                   wallpaper_id TEXT PRIMARY KEY REFERENCES wallpapers(id) ON DELETE CASCADE,
                   dhash TEXT NOT NULL
                 );
                 INSERT OR IGNORE INTO wallpaper_fingerprints(wallpaper_id,dhash)
                 SELECT f.wallpaper_id, f.dhash
                 FROM restore_source.wallpaper_fingerprints f
                 WHERE EXISTS (
                   SELECT 1 FROM restore_source.wallpaper_files sf
                   WHERE sf.wallpaper_id=f.wallpaper_id AND sf.storage_class='managed'
                 );"
            ).map_err(error)?;
        }
        conn.execute_batch(
            "INSERT OR IGNORE INTO wallpaper_categories(wallpaper_id,category_id)
             SELECT x.wallpaper_id,x.category_id
             FROM restore_source.wallpaper_categories x
             WHERE EXISTS (SELECT 1 FROM restore_source.wallpaper_files f
               WHERE f.wallpaper_id=x.wallpaper_id AND f.storage_class='managed');
             INSERT OR IGNORE INTO wallpaper_collections(wallpaper_id,collection_id)
             SELECT x.wallpaper_id,m.target_id
             FROM restore_source.wallpaper_collections x
             JOIN restore_collection_map m ON m.source_id=x.collection_id
             WHERE EXISTS (SELECT 1 FROM restore_source.wallpaper_files f
               WHERE f.wallpaper_id=x.wallpaper_id AND f.storage_class='managed');"
        ).map_err(error)?;
    }
    conn.execute_batch("DROP TABLE restore_collection_map;").map_err(error)?;
    if mode == "replace" {
        // Only Replace loads backed-up preferences/bookmarks. Merge is additive:
        // it never changes app settings, rotation timing/pause/pin state, background
        // preferences, or the user's current bookmarks. Even restoring the exact
        // backup just created must not reset the current rotation scheduler.
        // API credentials, backup destination and Windows startup remain local.
        conn.execute_batch(
            "UPDATE app_settings SET json=(SELECT json FROM restore_source.app_settings WHERE id=1)
              WHERE id=1;
             CREATE TABLE IF NOT EXISTS rotation_settings
               (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS background_preferences
               (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);"
        ).map_err(error)?;
        if attached_table_exists(conn, "background_preferences")? {
            conn.execute_batch(
                "INSERT OR IGNORE INTO background_preferences(id,json)
                   SELECT id,json FROM restore_source.background_preferences;
                 UPDATE background_preferences SET json=(
                   SELECT json FROM restore_source.background_preferences WHERE id=1)
                 WHERE EXISTS(SELECT 1 FROM restore_source.background_preferences WHERE id=1);"
            ).map_err(error)?;
        }
        let json: Option<String> = if attached_table_exists(conn, "rotation_settings")? {
            conn.query_row("SELECT json FROM restore_source.rotation_settings WHERE id=1",
                [], |r| r.get(0)).optional().map_err(error)?
        } else { None };
        if let Some(json) = json {
            let mut saved: serde_json::Value = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid rotation settings in backup: {e}"))?;
            saved["nextDueUnix"] = serde_json::Value::Null;
            saved["nextDiscoveryUnix"] = serde_json::Value::Null;
            saved["lastWallpaperId"] = serde_json::Value::Null;
            saved["lastError"] = serde_json::Value::Null;
            saved["preferences"]["paused"] = serde_json::Value::Bool(true);
            // Source collection IDs may map to the existing collection with the
            // same name under a different ID. Resolve by name.
            if saved.pointer("/preferences/rotationScope").and_then(|v| v.as_str()) == Some("collections") {
                if let Some(ids) = saved.pointer_mut("/preferences/collectionIds").and_then(|v| v.as_array_mut()) {
                    for id in ids.iter_mut() {
                        if let Some(source_id) = id.as_str() {
                            let mapped: Option<String> = conn.query_row(
                                "SELECT m.id FROM main.collections m
                                 JOIN restore_source.collections s
                                 ON m.name=s.name COLLATE NOCASE
                                 WHERE s.id=?1 LIMIT 1",
                                [source_id], |r| r.get(0),
                            ).optional().map_err(error)?;
                            if let Some(mapped) = mapped { *id = serde_json::Value::String(mapped); }
                        }
                    }
                }
            }
            let encoded = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO rotation_settings(id,json) VALUES(1,?1)
                 ON CONFLICT(id) DO UPDATE SET json=excluded.json",
                [encoded],
            ).map_err(error)?;
        }
        if attached_table_exists(conn, "browser_bookmarks")? {
            conn.execute_batch("DELETE FROM browser_bookmarks;").map_err(error)?;
            conn.execute_batch(
                "INSERT OR IGNORE INTO browser_bookmarks(url,title,folder,created_at)
                 SELECT url,title,folder,created_at
                 FROM restore_source.browser_bookmarks;"
            ).map_err(error)?;
        }
    }
    app_settings::read_settings(conn)?;
    if conn.prepare("PRAGMA main.foreign_key_check").map_err(error)?
        .exists([]).map_err(error)? {
        return Err("Restored data contains broken database relationships.".into());
    }
    Ok(())
}

/// Stage and verify files first, then promote only new filenames and apply
/// metadata in a transaction. On errors, roll back SQL and remove ONLY files
/// this restore created. Existing originals are never overwritten/deleted.
fn restore_locked(conn: &Connection, paths: &DataPaths, folder: &Path,
                  manifest: &Manifest, mode: &str) -> Result<RestoreResult, String> {
    let recovery = backup::create_recovery_snapshot(conn, paths)?;
    let (staging, pending) = stage_files(manifest, folder, paths)?;
    let mut promoted = Vec::new();
    let result = (|| {
        for (staged, target) in pending {
            if target.exists() { return Err("A Library file appeared during restore. Nothing was overwritten.".into()); }
            fs::rename(staged, &target)
                .map_err(|e| format!("Could not place restored Library image: {e}"))?;
            promoted.push(target);
        }
        conn.execute("ATTACH DATABASE ?1 AS restore_source",
            [folder.join("haven-walls.sqlite3").to_string_lossy().as_ref()])
            .map_err(error)?;
        let prefix = format!("restore-{}-", now_nanos());
        let transaction = (|| {
            conn.execute_batch("BEGIN IMMEDIATE;").map_err(error)?;
            let result = import_sql(conn, mode, &manifest.kind, &prefix);
            match result {
                Ok(_) => match conn.execute_batch("COMMIT;") {
                    Ok(_) => Ok(()),
                    Err(failure) => {
                        let _ = conn.execute_batch("ROLLBACK;");
                        Err(format!("Could not commit restored database: {failure}"))
                    }
                },
                Err(problem) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    Err(problem)
                }
            }
        })();
        let _ = conn.execute_batch("DETACH DATABASE restore_source;");
        transaction
    })();
    let _ = fs::remove_dir_all(staging);
    if let Err(problem) = result {
        for path in promoted { let _ = fs::remove_file(path); }
        return Err(format!("{problem} A pre-restore recovery copy is stored at {}.",
            recovery.display()));
    }
    Ok(RestoreResult {
        mode: mode.into(), kind: manifest.kind.clone(),
        restored_images: if manifest.kind == "full" {
            manifest.files.iter().filter(|f| f.path.starts_with("library/")).count()
        } else { 0 },
        recovery_path: recovery.display().to_string(),
        notice: if mode == "merge" {
            "Merge complete. Existing favorites, app settings, rotation schedule, pause/pin state and bookmarks were preserved. Reopen Haven Walls to refresh newly imported Library items.".into()
        } else {
            "Replace complete. Quit and reopen Haven Walls to refresh every view. Automatic wallpaper rotation is paused until you resume it.".into()
        },
    })
}
fn now_nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_nanos()
}
#[tauri::command]
pub async fn restore_backup(app: AppHandle, path: String,
                            manifest_hash: String, mode: String)
    -> Result<RestoreResult, String> {
    if mode != "merge" && mode != "replace" {
        return Err("Choose Merge or Replace.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let gate = app.state::<BackupGate>();
        let _gate = gate.0.lock().map_err(|_| "A backup is running.".to_string())?;
        let store = app.state::<StorageLock>();
        let _storage = store.0.lock().map_err(|_| "Storage is busy.".to_string())?;
        let paths = local_storage::current_paths(&app)?;
        local_storage::prepare_folders(&paths)?;
        let folder = backup_folder(&path)?;
        let (manifest, preview) = verified(&folder)?;
        if preview.manifest_hash != manifest_hash {
            return Err("Backup content changed since preview. Inspect it again before restoring.".into());
        }
        let conn = app_settings::open_database(&paths)?;
        restore_locked(&conn, &paths, &folder, &manifest, &mode)
    }).await.map_err(|_| "Restore worker was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_storage::StorageMode;

    fn storage(base: &Path) -> DataPaths {
        let paths = DataPaths { root: base.to_path_buf(), mode: StorageMode::AppData };
        local_storage::prepare_folders(&paths).unwrap();
        paths
    }
    fn tmp(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "haven-restore-{label}-{}-{}", std::process::id(), now_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn full_snapshot_merge_and_replace_preserve_live_credentials_and_recovery() {
        let root = tmp("full");
        let source_paths = storage(&root.join("source"));
        let original = app_settings::open_database(&source_paths).unwrap();
        original.execute_batch(
            "INSERT INTO collections(id,name) VALUES('sports','Sports');
             INSERT INTO categories(id,name) VALUES('sports-category','Basketball');
             INSERT INTO wallpapers(id,title,source,width,height,favorite)
                 VALUES('photo-a','Good photo','Local',2560,1440,1);
             INSERT INTO wallpaper_files
                 (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
                 VALUES('file-a','photo-a','photo-a.jpg','managed',6,'test');
             INSERT INTO wallpaper_collections(wallpaper_id,collection_id)
                 VALUES('photo-a','sports');
             INSERT INTO wallpaper_categories(wallpaper_id,category_id)
                 VALUES('photo-a','sports-category');"
        ).unwrap();
        fs::write(source_paths.library().join("photo-a.jpg"), b"image!").unwrap();
        let backup_folder = backup::create_recovery_snapshot(
            &original, &source_paths).unwrap();
        let (manifest, preview) = verified(&backup_folder).unwrap();
        assert_eq!(preview.image_count, 1);
        assert_eq!(preview.collection_count, 1);

        let target_paths = storage(&root.join("target"));
        let target = app_settings::open_database(&target_paths).unwrap();
        target.execute_batch(
            "INSERT INTO wallpapers(id,title,source,width,height,favorite)
                 VALUES('local-photo','Keep me','Local',2560,1440,0);
             INSERT INTO wallpaper_files
                 (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
                 VALUES('local-file','local-photo','local.jpg','managed',5,'live');
             INSERT INTO api_credentials(provider,ciphertext)
                 VALUES('tmdb',X'ABCD');"
        ).unwrap();
        fs::write(target_paths.library().join("local.jpg"), b"local").unwrap();
        let merged = restore_locked(&target, &target_paths, &backup_folder, &manifest, "merge").unwrap();
        assert!(Path::new(&merged.recovery_path).exists());
        assert!(target_paths.library().join("photo-a.jpg").is_file());
        let total: i64 = target.query_row(
            "SELECT COUNT(*) FROM wallpaper_files WHERE storage_class='managed'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2);
        let credentials: i64 = target.query_row(
            "SELECT COUNT(*) FROM api_credentials", [], |r| r.get(0)).unwrap();
        assert_eq!(credentials, 1);

        let replaced = restore_locked(&target, &target_paths, &backup_folder, &manifest, "replace").unwrap();
        assert!(Path::new(&replaced.recovery_path).exists());
        let total: i64 = target.query_row(
            "SELECT COUNT(*) FROM wallpaper_files WHERE storage_class='managed'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1);
        assert!(target_paths.library().join("local.jpg").exists()); // no destructive file deletion
        assert!(target_paths.library().join("photo-a.jpg").exists());
        let memberships: i64 = target.query_row(
            "SELECT COUNT(*) FROM wallpaper_collections WHERE wallpaper_id='photo-a'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(memberships, 1);
        let credentials: i64 = target.query_row(
            "SELECT COUNT(*) FROM api_credentials", [], |r| r.get(0)).unwrap();
        assert_eq!(credentials, 1);
        drop(target);
        drop(original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_only_replace_preserves_current_managed_library() {
        let root = tmp("settings");
        let source_paths = storage(&root.join("source"));
        let original = app_settings::open_database(&source_paths).unwrap();
        original.execute_batch(
            "INSERT INTO collections(id,name) VALUES('from-backup','New Collection');"
        ).unwrap();
        let backup_folder = backup::create_recovery_snapshot(&original, &source_paths).unwrap();

        // Build a settings-only manifest/database snapshot from the full
        // recovery fixture without touching the backup under test.
        let settings_folder = root.join("settings.hwbackup");
        fs::create_dir_all(&settings_folder).unwrap();
        fs::copy(backup_folder.join("haven-walls.sqlite3"),
            settings_folder.join("haven-walls.sqlite3")).unwrap();
        let mut manifest: Manifest = serde_json::from_slice(
            &fs::read(backup_folder.join("manifest.json")).unwrap()).unwrap();
        manifest.kind = "settings".into();
        manifest.files.retain(|f| f.path == "haven-walls.sqlite3");
        fs::write(settings_folder.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap()).unwrap();
        let (manifest, preview) = verified(&settings_folder).unwrap();
        assert_eq!(preview.kind, "settings");
        assert_eq!(preview.image_count, 0);

        let target_paths = storage(&root.join("target"));
        let target = app_settings::open_database(&target_paths).unwrap();
        target.execute_batch(
            "INSERT INTO collections(id,name) VALUES('existing','Existing');
             INSERT INTO wallpapers(id,title,source,width,height)
                VALUES('live','Live','Local',2560,1440);
             INSERT INTO wallpaper_files
                (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
                VALUES('live-file','live','live.jpg','managed',4,'hash');"
        ).unwrap();
        fs::write(target_paths.library().join("live.jpg"), b"live").unwrap();
        restore_locked(&target, &target_paths, &settings_folder, &manifest, "replace").unwrap();
        assert_eq!(target.query_row(
            "SELECT COUNT(*) FROM wallpaper_files WHERE storage_class='managed'",
            [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(target.query_row("SELECT COUNT(*) FROM collections",
            [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        drop(target);
        drop(original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merging_an_unchanged_full_backup_is_idempotent() {
        let root = tmp("same-backup");
        let paths = storage(&root.join("data"));
        let conn = app_settings::open_database(&paths).unwrap();
        conn.execute_batch(
            "INSERT INTO collections(id,name) VALUES('group','Favorites Collection');
             INSERT INTO categories(id,name) VALUES('category','Nature');
             INSERT INTO wallpapers(id,title,source,width,height,favorite)
                 VALUES('existing','Already here','Local',2560,1440,1);
             INSERT INTO wallpaper_files
                 (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
                 VALUES('existing-file','existing','existing.jpg','managed',5,'test');
             INSERT INTO wallpaper_collections(wallpaper_id,collection_id)
                 VALUES('existing','group');
             INSERT INTO wallpaper_categories(wallpaper_id,category_id)
                 VALUES('existing','category');
             CREATE TABLE rotation_settings(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             INSERT INTO rotation_settings(id,json)
                 VALUES(1,'{\"preferences\":{\"enabled\":true,\"paused\":false,\"pinned\":true},\"nextDueUnix\":12345}');
             CREATE TABLE background_preferences(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             INSERT INTO background_preferences(id,json)
                 VALUES(1,'{\"closeToTray\":true}');
             INSERT INTO browser_bookmarks(url,title,folder)
                 VALUES('https://example.com','Existing bookmark','Favorites');"
        ).unwrap();
        fs::write(paths.library().join("existing.jpg"), b"image").unwrap();
        let saved_app: String = conn.query_row(
            "SELECT json FROM app_settings WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        let saved_rotation: String = conn.query_row(
            "SELECT json FROM rotation_settings WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        let saved_background: String = conn.query_row(
            "SELECT json FROM background_preferences WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        let folder = backup::create_recovery_snapshot(&conn, &paths).unwrap();
        let (manifest, _) = verified(&folder).unwrap();

        // Re-import the very same full backup twice: both runs must preserve
        // current preferences and not duplicate any Library records.
        for _ in 0..2 {
            let result = restore_locked(&conn, &paths, &folder, &manifest, "merge").unwrap();
            assert!(result.notice.contains("preserved"));
            let app: String = conn.query_row(
                "SELECT json FROM app_settings WHERE id=1", [], |r| r.get(0)
            ).unwrap();
            let rotation: String = conn.query_row(
                "SELECT json FROM rotation_settings WHERE id=1", [], |r| r.get(0)
            ).unwrap();
            let background: String = conn.query_row(
                "SELECT json FROM background_preferences WHERE id=1", [], |r| r.get(0)
            ).unwrap();
            assert_eq!(app, saved_app);
            assert_eq!(rotation, saved_rotation);
            assert_eq!(background, saved_background);
            for table in ["wallpapers", "wallpaper_files", "wallpaper_collections",
                          "wallpaper_categories", "collections", "categories",
                          "browser_bookmarks"] {
                let amount: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0),
                ).unwrap();
                assert_eq!(amount, 1, "Merge duplicated records in {table}");
            }
            let favorite: i64 = conn.query_row(
                "SELECT favorite FROM wallpapers WHERE id='existing'",
                [], |r| r.get(0),
            ).unwrap();
            assert_eq!(favorite, 1);
            assert_eq!(fs::read(paths.library().join("existing.jpg")).unwrap(), b"image");
        }
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merging_older_backup_does_not_reset_newer_settings_or_favorite_choices() {
        let root = tmp("newer-preferences");
        let paths = storage(&root.join("data"));
        let conn = app_settings::open_database(&paths).unwrap();
        conn.execute_batch(
            "INSERT INTO wallpapers(id,title,source,width,height,favorite)
                 VALUES('photo','Photo','Local',2560,1440,1);
             INSERT INTO wallpaper_files
                 (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
                 VALUES('file','photo','photo.jpg','managed',5,'test');
             CREATE TABLE rotation_settings(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             INSERT INTO rotation_settings(id,json)
                 VALUES(1,'{\"preferences\":{\"paused\":false},\"nextDueUnix\":2222}');
             CREATE TABLE background_preferences(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             INSERT INTO background_preferences(id,json)
                 VALUES(1,'{\"closeToTray\":false}');
             INSERT INTO browser_bookmarks(url,title,folder)
                 VALUES('https://example.com/old','Old bookmark','Favorites');"
        ).unwrap();
        fs::write(paths.library().join("photo.jpg"), b"image").unwrap();
        let folder = backup::create_recovery_snapshot(&conn, &paths).unwrap();
        let (manifest, _) = verified(&folder).unwrap();

        // User changes the app after taking the backup. Merge must not revert
        // these changes or resurrect removed browser bookmarks.
        let old_app: String = conn.query_row(
            "SELECT json FROM app_settings WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        let mut new_app: serde_json::Value = serde_json::from_str(&old_app).unwrap();
        new_app["minimumResolution"] = serde_json::Value::String("4K".into());
        let new_app = serde_json::to_string(&new_app).unwrap();
        conn.execute("UPDATE app_settings SET json=?1 WHERE id=1", [&new_app]).unwrap();
        conn.execute_batch(
            "UPDATE wallpapers SET favorite=0 WHERE id='photo';
             UPDATE rotation_settings SET json='{\"preferences\":{\"paused\":true},\"nextDueUnix\":9999}' WHERE id=1;
             UPDATE background_preferences SET json='{\"closeToTray\":true}' WHERE id=1;
             DELETE FROM browser_bookmarks;"
        ).unwrap();
        restore_locked(&conn, &paths, &folder, &manifest, "merge").unwrap();
        let after_app: String = conn.query_row(
            "SELECT json FROM app_settings WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(after_app, new_app);
        let after_rotation: String = conn.query_row(
            "SELECT json FROM rotation_settings WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        assert!(after_rotation.contains("9999"));
        let after_background: String = conn.query_row(
            "SELECT json FROM background_preferences WHERE id=1", [], |r| r.get(0)
        ).unwrap();
        assert!(after_background.contains("true"));
        assert_eq!(conn.query_row(
            "SELECT favorite FROM wallpapers WHERE id='photo'",
            [], |r| r.get::<_, i64>(0),
        ).unwrap(), 0);
        assert_eq!(conn.query_row(
            "SELECT COUNT(*) FROM browser_bookmarks",
            [], |r| r.get::<_, i64>(0),
        ).unwrap(), 0);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_tampering_is_rejected_before_restore() {
        let root = tmp("tamper");
        let paths = storage(&root.join("data"));
        let conn = app_settings::open_database(&paths).unwrap();
        let folder = backup::create_recovery_snapshot(&conn, &paths).unwrap();
        let (_, original) = verified(&folder).unwrap();
        assert_eq!(original.kind, "full");
        fs::write(folder.join("haven-walls.sqlite3"), b"malicious data").unwrap();
        assert!(verified(&folder).is_err());
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }
}
