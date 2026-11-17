//! PR #7 Commit 3: Windows tray and explicit background/startup preferences.
//! No telemetry, cloud service, elevation or system-wide Run key.
use crate::{app_settings, local_storage::{self, StorageLock}, rotation};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BackgroundPreferences {
    close_to_tray: bool,
}
impl Default for BackgroundPreferences {
    fn default() -> Self { Self { close_to_tray: true } }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    close_to_tray: bool,
    launch_at_login: bool,
    startup_available: bool,
}

fn ensure(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS background_preferences (
            id INTEGER PRIMARY KEY CHECK(id=1),
            json TEXT NOT NULL
         );"
    ).map_err(|e| format!("Could not initialize background settings: {e}"))?;
    Ok(())
}
fn read(conn: &Connection) -> Result<BackgroundPreferences, String> {
    ensure(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO background_preferences(id,json) VALUES(1,?1)",
        params![r#"{"closeToTray":true}"#],
    ).map_err(|e| format!("Could not initialize background preferences: {e}"))?;
    let json: String = conn.query_row(
        "SELECT json FROM background_preferences WHERE id=1", [], |row| row.get(0)
    ).map_err(|e| format!("Could not read background preferences: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Saved background preferences are invalid: {e}"))
}
fn with_storage<T>(app: &AppHandle,
    action: impl FnOnce(&Connection) -> Result<T, String>
) -> Result<T, String> {
    let lock = app.state::<StorageLock>();
    let _guard = lock.0.lock().map_err(|_| "Wallpaper storage is busy.".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    action(&conn)
}

#[cfg(windows)]
mod startup {
    use std::{env, os::windows::process::CommandExt, process::Command};

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "HavenWalls";
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    fn executable_command() -> Result<String, String> {
        let path = env::current_exe()
            .map_err(|e| format!("Could not identify Haven Walls executable: {e}"))?;
        let text = path.to_string_lossy();
        if text.contains('"') {
            return Err("The installed executable has an invalid filename.".into());
        }
        let command = format!("\"{text}\" --background");
        if command.len() > 260 {
            return Err("The installed executable path is too long for Windows startup.".into());
        }
        Ok(command)
    }
    fn run_reg(args: &[&str]) -> Result<std::process::Output, String> {
        Command::new("reg.exe").args(args).creation_flags(CREATE_NO_WINDOW)
            .output().map_err(|e| format!("Windows startup settings could not be accessed: {e}"))
    }
    pub fn installed() -> Result<bool, String> {
        let output = run_reg(&["query", RUN_KEY, "/v", VALUE_NAME])?;
        if !output.status.success() { return Ok(false); }
        let recorded = String::from_utf8_lossy(&output.stdout);
        // Show enabled only if this *specific installed executable* owns the
        // current per-user Run entry. An old or relocated install isn't active.
        Ok(recorded.contains(&executable_command()?))
    }
    pub fn set(enabled: bool) -> Result<(), String> {
        if enabled {
            let command = executable_command()?;
            let output = run_reg(&[
                "add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ",
                "/d", &command, "/f"
            ])?;
            if !output.status.success() {
                return Err("Windows rejected this user's startup preference.".into());
            }
        } else {
            let output = run_reg(&["query", RUN_KEY, "/v", VALUE_NAME])?;
            if !output.status.success() { return Ok(()); }
            let deleted = run_reg(&["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])?;
            if !deleted.status.success() {
                return Err("Windows could not remove the Haven Walls startup entry.".into());
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod startup {
    pub fn installed() -> Result<bool, String> { Ok(false) }
    pub fn set(_enabled: bool) -> Result<(), String> {
        Err("Windows startup is available only on Windows.".into())
    }
}

fn startup_available() -> bool {
    cfg!(windows) && !cfg!(debug_assertions)
}

#[tauri::command]
pub fn get_background_status(app: AppHandle) -> Result<BackgroundStatus, String> {
    let prefs = with_storage(&app, read)?;
    Ok(BackgroundStatus {
        close_to_tray: prefs.close_to_tray,
        launch_at_login: if startup_available() { startup::installed()? } else { false },
        startup_available: startup_available(),
    })
}

#[tauri::command]
pub fn save_background_settings(
    app: AppHandle, close_to_tray: bool, launch_at_login: bool,
) -> Result<BackgroundStatus, String> {
    let old = get_background_status(app.clone())?;
    if launch_at_login != old.launch_at_login {
        if !startup_available() {
            return Err("Configure Windows login startup from the installed release executable, not tauri dev.".into());
        }
        startup::set(launch_at_login)?;
    }
    let saved = with_storage(&app, |conn| {
        ensure(conn)?;
        let json = serde_json::to_string(&BackgroundPreferences { close_to_tray })
            .map_err(|e| format!("Could not encode background preferences: {e}"))?;
        conn.execute("INSERT INTO background_preferences(id,json) VALUES(1,?1)
            ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![json])
            .map_err(|e| format!("Could not save background preferences: {e}"))?;
        Ok(())
    });
    if let Err(error) = saved {
        if launch_at_login != old.launch_at_login { let _ = startup::set(old.launch_at_login); }
        return Err(error);
    }
    get_background_status(app)
}

/// Close to tray only when rotation is enabled. Disabling rotation restores
/// normal Close => Exit, even if the saved keep-running option remains on.
pub fn keep_running_on_close(app: &AppHandle) -> bool {
    let enabled = rotation::is_enabled(app).unwrap_or(false);
    enabled && with_storage(app, |conn| Ok(read(conn)?.close_to_tray)).unwrap_or(false)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "haven_open", "Open Haven Walls", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "haven_next", "Next wallpaper", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "haven_pause", "Pause / Resume rotation", true, None::<&str>)?;
    let pin = MenuItem::with_id(app, "haven_pin", "Pin / Unpin current", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "haven_quit", "Quit Haven Walls", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &next, &pause, &pin, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Haven Walls - Automatic wallpaper rotation")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "haven_open" => show_main(app),
            "haven_next" => {
                let a = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = rotation::rotation_next(a).await {
                        eprintln!("Tray Next wallpaper: {error}");
                    }
                });
            },
            "haven_pause" => {
                let a = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = rotation::toggle_pause(&a) {
                        eprintln!("Tray Pause/Resume: {error}");
                    }
                });
            },
            "haven_pin" => {
                let a = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = rotation::toggle_pin(&a) {
                        eprintln!("Tray Pin/Unpin: {error}");
                    }
                });
            },
            "haven_quit" => app.exit(0),
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up, ..
            } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // The per-user Run entry launches with --background, so a login start
    // doesn't unexpectedly open a large window on the desktop.
    if std::env::args_os().any(|argument| argument.to_string_lossy() == "--background") {
        if let Some(window) = app.get_webview_window("main") {
            window.hide()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_to_tray_defaults_on_but_startup_is_separate() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(read(&conn).unwrap().close_to_tray);
    }
}
