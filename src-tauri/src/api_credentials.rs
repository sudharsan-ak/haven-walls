//! Durable, Windows-user-protected API keys. Stored as DPAPI ciphertext in
//! the existing Haven Walls SQLite database, never in the binary, browser
//! localStorage, build output, logs, or a checked-in configuration file.
//!
//! The data DB survives a normal app update/rebuild and follows the existing
//! AppData/portable storage migration. DPAPI is bound to the Windows user:
//! copying the portable folder to another Windows account does not transfer
//! decryptability. In that case the key can be removed and entered again.
use crate::{app_settings, local_storage::{self, StorageLock}};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub serpapi: bool,
    pub unsplash: bool,
    pub tmdb: bool,
}

fn allowed(provider: &str) -> Result<&str, String> {
    match provider {
        "serpapi" | "unsplash" | "tmdb" => Ok(provider),
        _ => Err("Unknown API credential provider.".into()),
    }
}
fn database(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    app_settings::open_database(&paths)
}
fn status(conn: &rusqlite::Connection) -> Result<CredentialStatus, String> {
    let configured = |provider: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM api_credentials WHERE provider=?1)",
            params![provider], |row| row.get::<_, bool>(0),
        ).map_err(|_| "Could not check saved API credentials.".to_string())
    };
    Ok(CredentialStatus {
        serpapi: configured("serpapi")?,
        unsplash: configured("unsplash")?,
        tmdb: configured("tmdb")?,
    })
}
fn read_encrypted(conn: &rusqlite::Connection, provider: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT ciphertext FROM api_credentials WHERE provider=?1",
        params![provider], |row| row.get(0),
    ).optional().map_err(|_| "Could not read saved API credential.".to_string())
}

/// Used internally in Rust by provider requests. Never returned through IPC.
pub fn required(app: &AppHandle, provider: &str) -> Result<String, String> {
    allowed(provider)?;
    let conn = database(app)?;
    let bytes = read_encrypted(&conn, provider)?
        .ok_or_else(|| format!("Add your {provider} API key under Settings → API credentials."))?;
    unprotect(&bytes).map_err(|_| {
        format!("The saved {provider} API key could not be decrypted for this Windows user. Remove and re-enter it in Settings.")
    })
}
#[tauri::command]
pub fn get_api_credential_status(
    app: AppHandle, state: State<'_, StorageLock>,
) -> Result<CredentialStatus, String> {
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    status(&database(&app)?)
}
#[tauri::command]
pub fn save_api_credential(
    app: AppHandle, state: State<'_, StorageLock>,
    provider: String, value: String,
) -> Result<CredentialStatus, String> {
    allowed(&provider)?;
    let key = value.trim();
    if key.len() < 3 || key.len() > 4096 || key.chars().any(char::is_control) {
        return Err("API key must be 3–4096 characters without line breaks or control characters.".into());
    }
    let ciphertext = protect(key.as_bytes())
        .map_err(|_| "Windows could not protect the API credential. Nothing was saved.".to_string())?;
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    let conn = database(&app)?;
    conn.execute(
        "INSERT INTO api_credentials(provider,ciphertext) VALUES(?1,?2)
         ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext",
        params![provider, ciphertext],
    ).map_err(|_| "Could not save the encrypted API credential.".to_string())?;
    status(&conn)
}
#[tauri::command]
pub fn remove_api_credential(
    app: AppHandle, state: State<'_, StorageLock>, provider: String,
) -> Result<CredentialStatus, String> {
    allowed(&provider)?;
    let _lock = state.0.lock().map_err(|_| "Storage operation interrupted".to_string())?;
    let conn = database(&app)?;
    conn.execute("DELETE FROM api_credentials WHERE provider=?1", params![provider])
        .map_err(|_| "Could not remove saved API credential.".to_string())?;
    status(&conn)
}

#[cfg(windows)]
mod windows_dpapi {
    use std::ffi::c_void;
    #[repr(C)]
    struct DataBlob {
        size: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(input: *const DataBlob, description: *const u16,
            entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void,
            flags: u32, output: *mut DataBlob) -> i32;
        fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16,
            entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void,
            flags: u32, output: *mut DataBlob) -> i32;
    }
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(pointer: *mut c_void) -> *mut c_void;
    }
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn run(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
        if bytes.is_empty() || bytes.len() > 16_384 {
            return Err("Invalid protected credential length".into());
        }
        let input = DataBlob { size: bytes.len() as u32, data: bytes.as_ptr() as *mut u8 };
        let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
        let ok = unsafe {
            if decrypt {
                CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(),
                    std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            } else {
                CryptProtectData(&input, std::ptr::null(), std::ptr::null(),
                    std::ptr::null_mut(), std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            }
        };
        if ok == 0 { return Err("Windows DPAPI failed".into()); }
        if output.data.is_null() {
            return Err("Windows DPAPI returned no protected data".into());
        }
        let result = unsafe {
            let buffer = std::slice::from_raw_parts(output.data, output.size as usize).to_vec();
            LocalFree(output.data.cast());
            buffer
        };
        Ok(result)
    }
    pub(super) fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> { run(bytes, false) }
    pub(super) fn unprotect(bytes: &[u8]) -> Result<String, String> {
        String::from_utf8(run(bytes, true)?).map_err(|_| "Invalid decrypted credential".into())
    }
}
#[cfg(windows)]
use windows_dpapi::{protect, unprotect};

#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Persistent API credentials require Windows DPAPI.".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<String, String> {
    Err("Persistent API credentials require Windows DPAPI.".into())
}


#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::local_storage::{DataPaths, StorageMode};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn dpapi_encrypts_and_recovers_credential_for_current_windows_user() {
        let key = "test-key-not-a-real-credential";
        let encrypted = protect(key.as_bytes()).expect("Windows DPAPI encryption should succeed");
        assert_ne!(encrypted, key.as_bytes());
        let restored = unprotect(&encrypted).expect("Windows DPAPI decryption should succeed");
        assert_eq!(restored, key);
    }

    #[test]
    fn credential_persists_across_database_reopens_and_schema_initialization() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
            .expect("system clock").as_nanos();
        let root = std::env::temp_dir().join(format!(
            "haven-walls-credential-test-{}-{stamp}", std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temporary data root");
        let paths = DataPaths { root: root.clone(), mode: StorageMode::AppData };
        {
            let conn = app_settings::open_database(&paths).expect("create DB");
            let value = protect(b"test-persisted-key").expect("encrypt key");
            conn.execute(
                "INSERT INTO api_credentials(provider,ciphertext) VALUES (?1, ?2)",
                params!["serpapi", value],
            ).expect("write encrypted credential");
        }
        {
            // Normal app restart/rebuild runs open_database again. CREATE TABLE
            // IF NOT EXISTS must not overwrite encrypted credentials.
            let conn = app_settings::open_database(&paths).expect("reopen DB");
            let cipher = read_encrypted(&conn, "serpapi")
                .expect("read DB").expect("credential should still exist");
            assert_eq!(unprotect(&cipher).expect("decrypt"), "test-persisted-key");
            assert!(status(&conn).expect("status").serpapi);
        }
        fs::remove_dir_all(root).expect("remove temporary test DB");
    }
}
