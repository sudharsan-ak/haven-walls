//! Tauri IPC commands for settings and local storage. All operations are
//! serialized through StorageLock; no remote webview gets these capabilities.
use crate::{
    app_settings::{self, AppSettings},
    local_storage::{self, StorageLock, StorageMode, StorageStatus},
};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSnapshot {
    settings: AppSettings,
    storage: StorageStatus,
}

fn snapshot(app: &AppHandle) -> Result<ConfigurationSnapshot, String> {
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    let settings = app_settings::read_settings(&conn)?;
    let storage = local_storage::status(&paths)?;
    Ok(ConfigurationSnapshot { settings, storage })
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    app_settings::read_settings(&conn)?;
    Ok(())
}

#[tauri::command]
pub fn get_configuration(
    app: AppHandle,
    state: State<'_, StorageLock>,
) -> Result<ConfigurationSnapshot, String> {
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    snapshot(&app)
}

#[tauri::command]
pub fn save_configuration(
    app: AppHandle,
    state: State<'_, StorageLock>,
    settings: AppSettings,
) -> Result<ConfigurationSnapshot, String> {
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    let paths = local_storage::current_paths(&app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    app_settings::save_settings(&conn, settings)?;
    drop(conn);
    snapshot(&app)
}

#[tauri::command]
pub fn change_storage_mode(
    app: AppHandle,
    state: State<'_, StorageLock>,
    mode: StorageMode,
) -> Result<ConfigurationSnapshot, String> {
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    let migrated = local_storage::migrate_storage(&app, mode)?;
    local_storage::prepare_folders(&migrated)?;
    // Validate the migrated SQLite DB before presenting the destination.
    let conn = app_settings::open_database(&migrated)?;
    app_settings::read_settings(&conn)?;
    drop(conn);
    snapshot(&app)
}

#[tauri::command]
pub fn clear_temporary_cache(
    app: AppHandle,
    state: State<'_, StorageLock>,
) -> Result<ConfigurationSnapshot, String> {
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    let paths = local_storage::current_paths(&app)?;
    local_storage::clear_discovery_cache(&paths)?;
    snapshot(&app)
}
