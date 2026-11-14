//! Storage roots and ownership boundaries. Only app-owned directories may be
//! migrated or cleared. The user's originals and active wallpapers are separate.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

/// Serialize all storage and settings changes, including location migration.
#[derive(Default)]
pub struct StorageLock(pub Mutex<()>);

const DB_NAME: &str = "haven-walls.sqlite3";
const PORTABLE_MARKER: &str = ".haven-walls-portable";
const PORTABLE_FOLDER: &str = "HavenWallsData";

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageMode {
    AppData,
    Portable,
}

#[derive(Debug, Clone)]
pub struct DataPaths {
    pub root: PathBuf,
    pub mode: StorageMode,
}

impl DataPaths {
    pub fn database(&self) -> PathBuf { self.root.join(DB_NAME) }
    pub fn discovery_cache(&self) -> PathBuf { self.root.join("cache").join("discovery") }
    pub fn pending_cache(&self) -> PathBuf { self.root.join("cache").join("pending") }
    pub fn library(&self) -> PathBuf { self.root.join("library") }
    pub fn active(&self) -> PathBuf { self.root.join("active") }
    pub fn offline_reserve(&self) -> PathBuf { self.root.join("reserve") }
}

fn app_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|root| root.join("data"))
        .map_err(|e| format!("Could not locate Windows AppData: {e}"))
}

fn portable_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|e| format!("Could not locate the Haven Walls EXE: {e}"))?;
    let parent = executable.parent()
        .ok_or_else(|| "Could not locate the EXE folder".to_string())?;
    Ok(parent.join(PORTABLE_FOLDER))
}

pub fn current_paths(app: &AppHandle) -> Result<DataPaths, String> {
    let portable = portable_path()?;
    if portable.join(PORTABLE_MARKER).is_file() {
        return Ok(DataPaths { root: portable, mode: StorageMode::Portable });
    }
    Ok(DataPaths { root: app_data_path(app)?, mode: StorageMode::AppData })
}

pub fn prepare_folders(paths: &DataPaths) -> Result<(), String> {
    for path in [
        &paths.root, &paths.discovery_cache(), &paths.pending_cache(),
        &paths.library(), &paths.active(), &paths.offline_reserve(),
    ] {
        fs::create_dir_all(path)
            .map_err(|e| format!("Could not create data folder {}: {e}", path.display()))?;
    }
    Ok(())
}

fn folder_bytes(path: &Path) -> Result<u64, String> {
    if !path.exists() { return Ok(0); }
    let mut total = 0u64;
    for entry in fs::read_dir(path)
        .map_err(|e| format!("Could not check disk usage: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Could not list storage file: {e}"))?;
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Could not inspect storage entry: {e}"))?;
        if meta.file_type().is_symlink() { continue; }
        if meta.is_dir() {
            total = total.saturating_add(folder_bytes(&entry.path())?);
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub mode: StorageMode,
    pub root_path: String,
    pub discovery_bytes: u64,
    pub pending_bytes: u64,
    pub managed_bytes: u64,
    pub active_bytes: u64,
    pub offline_reserve_bytes: u64,
    pub database_bytes: u64,
}

pub fn status(paths: &DataPaths) -> Result<StorageStatus, String> {
    Ok(StorageStatus {
        mode: paths.mode,
        root_path: paths.root.display().to_string(),
        discovery_bytes: folder_bytes(&paths.discovery_cache())?,
        pending_bytes: folder_bytes(&paths.pending_cache())?,
        managed_bytes: folder_bytes(&paths.library())?,
        active_bytes: folder_bytes(&paths.active())?,
        offline_reserve_bytes: folder_bytes(&paths.offline_reserve())?,
        database_bytes: fs::metadata(paths.database()).map(|m| m.len()).unwrap_or(0),
    })
}

/// Only disposable discovery cache can be cleared here. Active, favorites,
/// managed library, pending approval and offline reserve are never touched.
pub fn clear_discovery_cache(paths: &DataPaths) -> Result<u64, String> {
    let path = paths.discovery_cache();
    if !path.exists() { return Ok(0); }
    if fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?.file_type().is_symlink()
    {
        return Err("Discovery cache path unexpectedly points to a link. Refusing cleanup.".into());
    }
    let bytes = folder_bytes(&path)?;
    fs::remove_dir_all(&path)
        .map_err(|e| format!("Could not clear discovery cache: {e}"))?;
    fs::create_dir_all(&path)
        .map_err(|e| format!("Could not restore cache folder: {e}"))?;
    Ok(bytes)
}

fn copy_owned_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target)
        .map_err(|e| format!("Could not create migration folder {}: {e}", target.display()))?;
    for entry in fs::read_dir(source).map_err(|e| format!("Could not read storage folder: {e}"))? {
        let entry = entry.map_err(|e| format!("Could not read a storage entry: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Could not inspect storage entry: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Storage contains a symbolic link. Migration was stopped to protect external files.".into());
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_owned_dir(&entry.path(), &destination)?;
        } else if metadata.is_file() {
            let bytes = fs::copy(entry.path(), &destination)
                .map_err(|e| format!("Could not copy storage data: {e}"))?;
            if bytes != metadata.len() {
                return Err("Storage migration did not fully copy a file.".into());
            }
        } else {
            return Err("Storage contains an unsupported entry. Migration was stopped.".into());
        }
    }
    Ok(())
}

/// Migrate into a NEW empty destination with a staging directory. Existing
/// target data is never overwritten or deleted. The old root is retained as
/// a recovery copy; switching back requires resolving a conflicting old root.
pub fn migrate_storage(app: &AppHandle, desired: StorageMode) -> Result<DataPaths, String> {
    let old = current_paths(app)?;
    if matches!((old.mode, desired),
        (StorageMode::AppData, StorageMode::AppData)
            | (StorageMode::Portable, StorageMode::Portable))
    {
        return Ok(old);
    }
    let target = match desired {
        StorageMode::AppData => app_data_path(app)?,
        StorageMode::Portable => portable_path()?,
    };
    if target.exists() {
        return Err(format!(
            "The destination already has data at {}. Haven Walls will not overwrite it. \
            Choose an empty location or keep your current storage mode.",
            target.display()
        ));
    }

    let staging = target.with_extension("haven-walls-migrating");
    if staging.exists() {
        return Err(format!(
            "An incomplete storage migration exists at {}. Please inspect it before retrying.",
            staging.display()
        ));
    }
    let parent = target.parent().ok_or_else(|| "Storage destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Storage destination is not writable: {e}"))?;

    // Copy all owned data with no DB handles open (caller holds StorageLock).
    // Keep staging on error so user can inspect/recover. Never remove source.
    copy_owned_dir(&old.root, &staging)?;
    if matches!(desired, StorageMode::Portable) {
        fs::write(staging.join(PORTABLE_MARKER), b"Haven Walls portable data v1\n")
            .map_err(|e| format!("Could not prepare portable storage: {e}"))?;
    } else {
        // Copying the previous portable marker into AppData must not make
        // app data accidentally look like a portable installation.
        let marker = staging.join(PORTABLE_MARKER);
        if marker.exists() {
            fs::remove_file(marker).map_err(|e| format!("Could not finalize storage: {e}"))?;
        }
    }
    fs::rename(&staging, &target)
        .map_err(|e| format!("Storage migration could not be committed: {e}"))?;
    if matches!(desired, StorageMode::AppData) {
        // Stop reading the old portable root only after a full copy commits.
        let marker = old.root.join(PORTABLE_MARKER);
        fs::remove_file(marker)
            .map_err(|e| format!("Data copied but portable marker could not be removed: {e}"))?;
    }
    Ok(DataPaths { root: target, mode: desired })
}
