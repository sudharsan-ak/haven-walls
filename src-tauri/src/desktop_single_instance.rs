//! One Haven Walls instance per Windows login session.
//! A second launch signals the first process to show its main window and
//! exits before a second scheduler or tray icon can be created.
//! Uses the already-pinned Windows crate, no additional service or dependency.
use tauri::{AppHandle, Manager};
use windows::{
    core::w,
    Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0},
        System::Threading::{CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject},
    },
};

// Local\\ is session-scoped, so a different signed-in Windows session
// can run its own wallpaper manager without interacting with this user.
const MUTEX_NAME: windows::core::PCWSTR = w!("Local\\HavenWalls_Desktop_SingleInstance_v1");
const WAKE_NAME: windows::core::PCWSTR = w!("Local\\HavenWalls_Desktop_Activate_v1");

pub struct ProcessGuard {
    mutex: HANDLE,
    event: HANDLE,
}
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.event);
            let _ = CloseHandle(self.mutex);
        }
    }
}

/// Acquire the process guard *before* starting Tauri. If another instance is
/// already running, notify it and return None. Do not focus the GUI for a
/// background autostart attempt, which should be invisible to the user.
pub fn acquire() -> Result<Option<ProcessGuard>, String> {
    unsafe {
        let mutex = CreateMutexW(None, false, MUTEX_NAME)
            .map_err(|e| format!("Could not check existing Haven Walls process: {e}"))?;
        let existed = GetLastError() == ERROR_ALREADY_EXISTS;
        if existed {
            if !std::env::args_os().any(|arg| arg.to_string_lossy() == "--background") {
                if let Ok(event) = CreateEventW(None, false, false, WAKE_NAME) {
                    let _ = SetEvent(event);
                    let _ = CloseHandle(event);
                }
            }
            let _ = CloseHandle(mutex);
            return Ok(None);
        }
        let event = match CreateEventW(None, false, false, WAKE_NAME) {
            Ok(event) => event,
            Err(error) => {
                let _ = CloseHandle(mutex);
                return Err(format!("Could not initialize process activation: {error}"));
            }
        };
        Ok(Some(ProcessGuard { mutex, event }))
    }
}

/// Wait off the UI thread for a subsequent user's launch request.
pub fn watch_activation(app: AppHandle) {
    let _ = std::thread::Builder::new().name("haven-activate".into())
        .spawn(move || {
            let Ok(event) = (unsafe { CreateEventW(None, false, false, WAKE_NAME) })
                else { return; };
            loop {
                let result = unsafe { WaitForSingleObject(event, 1000) };
                if result == WAIT_OBJECT_0 {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                if app.get_webview_window("main").is_none() { break; }
            }
            unsafe { let _ = CloseHandle(event); }
        });
}
