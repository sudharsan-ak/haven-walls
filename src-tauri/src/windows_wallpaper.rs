//! Windows desktop wallpaper management. User-triggered, offline-only.
use serde::Serialize;
use tauri::{AppHandle, Manager};
use crate::{app_settings, local_storage::{self, StorageLock}};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, time::{SystemTime, UNIX_EPOCH}};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct MonitorInfo {
    pub id: String, pub name: String,
    pub width: u32, pub height: u32, pub left: i32, pub top: i32,
    pub is_primary: bool,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Activity {
    pub current: Vec<CurrentWallpaper>,
    pub history: Vec<HistoryEntry>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct CurrentWallpaper {
    pub target_id: String, pub wallpaper_id: String, pub title: String,
    pub applied_at: String,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct HistoryEntry {
    pub wallpaper_id: Option<String>, pub title: String,
    pub target_id: String, pub fit: String, pub applied_at: String,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApplyResult { pub notice: String, pub target_id: String, pub wallpaper_id: String }

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS active_assignments (
           target_id TEXT PRIMARY KEY,
           wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE RESTRICT,
           relative_path TEXT NOT NULL,
           applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );"
    ).map_err(|e| format!("Could not initialize current wallpaper records: {e}"))
}

#[tauri::command]
pub fn list_wallpaper_monitors() -> Result<Vec<MonitorInfo>, String> {
    platform::monitors()
}

#[tauri::command]
pub fn get_wallpaper_activity(app: AppHandle) -> Result<Activity, String> {
    let state = app.state::<StorageLock>();
    let _lock = state.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(&app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    ensure_schema(&conn)?;
    let mut active_stmt = conn.prepare(
        "SELECT a.target_id,a.wallpaper_id,w.title,a.applied_at
         FROM active_assignments a JOIN wallpapers w ON w.id=a.wallpaper_id
         ORDER BY a.target_id"
    ).map_err(|e| format!("Could not read active wallpaper: {e}"))?;
    let active_rows = active_stmt.query_map([], |row| Ok(CurrentWallpaper {
        target_id: row.get(0)?, wallpaper_id: row.get(1)?,
        title: row.get(2)?, applied_at: row.get(3)?,
    })).map_err(|e| format!("Could not read active wallpaper: {e}"))?;
    let mut current = Vec::new();
    for entry in active_rows {
        current.push(entry.map_err(|e| format!("Could not read wallpaper entry: {e}"))?);
    }
    let mut hist_stmt = conn.prepare(
        "SELECT e.wallpaper_id,COALESCE(w.title,'Removed wallpaper'),
                e.target_id,COALESCE(e.detail,''),e.event_time
         FROM wallpaper_events e LEFT JOIN wallpapers w ON w.id=e.wallpaper_id
         WHERE e.action='apply' ORDER BY e.id DESC LIMIT 40"
    ).map_err(|e| format!("Could not read history: {e}"))?;
    let rows = hist_stmt.query_map([], |row| Ok(HistoryEntry {
        wallpaper_id: row.get(0)?, title: row.get(1)?, target_id: row.get(2)?,
        fit: row.get(3)?, applied_at: row.get(4)?,
    })).map_err(|e| format!("Could not read history: {e}"))?;
    let mut history = Vec::new();
    for item in rows {
        history.push(item.map_err(|e| format!("Could not read history item: {e}"))?);
    }
    Ok(Activity { current, history })
}

fn encode_original(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let photo = image::load_from_memory(bytes)
        .map_err(|e| format!("Could not decode saved wallpaper: {e}"))?;
    let count = u64::from(photo.width()) * u64::from(photo.height());
    if count == 0 || count > 90_000_000 { return Err("Image is too large to apply.".into()); }
    let mut jpeg = Vec::new();
    photo.write_with_encoder(
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 91)
    )
        .map_err(|e| format!("Could not prepare a Windows-compatible JPEG: {e}"))?;
    Ok(jpeg)
}

fn decode_overlay(raw: &str) -> Result<Vec<u8>, String> {
    if raw.len() > 45_000_000 { return Err("Captioned wallpaper is too large.".into()); }
    let bytes = BASE64.decode(raw)
        .map_err(|_| "Could not decode caption/credit image.".to_string())?;
    if bytes.len() > 33_000_000 { return Err("Captioned wallpaper is too large.".into()); }
    let photo = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Caption/credit image is not a valid JPEG: {e}"))?;
    if u64::from(photo.width()) * u64::from(photo.height()) > 90_000_000 {
        return Err("Captioned image dimensions are too large.".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn apply_library_wallpaper(
    app: AppHandle, wallpaper_id: String, target_id: String,
    fit: Option<String>, overlay_jpeg_base64: Option<String>,
) -> Result<ApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move ||
        apply_sync(&app, wallpaper_id, target_id, fit, overlay_jpeg_base64)
    ).await.map_err(|_| "Wallpaper operation was interrupted.".to_string())?
}

fn apply_sync(
    app: &AppHandle, wallpaper_id: String, target_id: String,
    fit: Option<String>, overlay: Option<String>,
) -> Result<ApplyResult, String> {
    let state = app.state::<StorageLock>();
    let _guard = state.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let mut conn = app_settings::open_database(&paths)?;
    ensure_schema(&conn)?;
    let settings = app_settings::read_settings(&conn)?;
    let fit = fit.unwrap_or(settings.wallpaper_fit);
    if !["smartFit","fill","fit","stretch","center","span"].contains(&fit.as_str()) {
        return Err("Select a valid wallpaper fit.".into());
    }
    if fit == "span" && target_id != "all" {
        return Err("Span requires All displays.".into());
    }
    let monitors = platform::monitors()?;
    if monitors.is_empty() {
        return Err("Windows did not report any attached displays.".into());
    }
    if target_id != "all" && !monitors.iter().any(|m| m.id == target_id) {
        return Err("Selected display is not attached. Refresh your monitor list.".into());
    }
    if wallpaper_id.len() != 64 || !wallpaper_id.bytes().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid Library wallpaper ID.".into());
    }
    let data: Option<(String,String)> = conn.query_row(
        "SELECT f.relative_path,w.title FROM wallpapers w
         JOIN wallpaper_files f ON f.wallpaper_id=w.id
         WHERE w.id=?1 AND f.storage_class='managed' LIMIT 1",
        params![wallpaper_id], |row| Ok((row.get(0)?,row.get(1)?))
    ).optional().map_err(|e| format!("Could not find wallpaper: {e}"))?;
    let (file_name,title) = data.ok_or_else(|| "Wallpaper not found in your local Library.".to_string())?;
    if !["jpg","png","webp"].iter().any(|ext| file_name == format!("{wallpaper_id}.{ext}")) {
        return Err("Unexpected managed wallpaper filename.".into());
    }
    let bytes = fs::read(paths.library().join(file_name))
        .map_err(|e| format!("Could not read managed wallpaper: {e}"))?;
    let jpeg = if let Some(encoded) = overlay { decode_overlay(&encoded)? }
        else { encode_original(&bytes)? };
    let dimensions = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Could not inspect prepared JPEG: {e}"))?;
    let width = dimensions.width();
    let height = dimensions.height();
    drop(dimensions);

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is not available.".to_string())?.as_nanos();
    let name = format!("{}-{nanos}.jpg",&wallpaper_id[..12]);
    let staged = paths.active().join(format!("{name}.staging"));
    let active = paths.active().join(&name);
    fs::write(&staged,&jpeg).map_err(|e| format!("Could not prepare active wallpaper file: {e}"))?;
    fs::rename(&staged,&active).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!("Could not save active wallpaper: {e}")
    })?;

    // Native COM call precedes DB recording; if COM fails, the staged image
    // is removed and the previous active assignment remains intact.
    let before = match platform::apply(&active,&target_id,&fit,(width,height),&monitors) {
        Ok(old) => old,
        Err(error) => {
            let _ = fs::remove_file(active);
            return Err(error);
        }
    };
    let older: Result<Vec<String>, String> = (|| {
        let mut st = conn.prepare(
            "SELECT relative_path FROM active_assignments
             WHERE ?1='all' OR target_id=?1"
        ).map_err(|e| format!("Could not inspect earlier active files: {e}"))?;
        let rows = st.query_map(params![target_id], |row| row.get::<_,String>(0))
            .map_err(|e| format!("Could not read active assignments: {e}"))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row.map_err(|e| format!("Could not read active file: {e}"))?);
        }
        Ok(paths)
    })();
    let prior = match older {
        Ok(v) => v,
        Err(e) => {
            platform::restore(&before,&target_id);
            let _ = fs::remove_file(active);
            return Err(e);
        }
    };

    let transaction_result = (|| -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| format!("Could not start wallpaper transaction: {e}"))?;
        for older in &prior {
            tx.execute("DELETE FROM wallpaper_files WHERE storage_class='active' AND relative_path=?1",
                params![older]).map_err(|e| format!("Could not update old active file: {e}"))?;
        }
        tx.execute("DELETE FROM active_assignments WHERE ?1='all' OR target_id=?1",
            params![target_id]).map_err(|e| format!("Could not update monitor assignment: {e}"))?;
        let hash = format!("{:x}",Sha256::digest(&jpeg));
        let record = format!("{:x}",Sha256::digest(name.as_bytes()));
        tx.execute(
            "INSERT INTO wallpaper_files (id,wallpaper_id,relative_path,storage_class,bytes,checksum_sha256)
             VALUES (?1,?2,?3,'active',?4,?5)",
            params![record,wallpaper_id,name,jpeg.len() as i64,hash]
        ).map_err(|e| format!("Could not protect the active wallpaper copy: {e}"))?;
        tx.execute("INSERT INTO active_assignments (target_id,wallpaper_id,relative_path)
            VALUES (?1,?2,?3)",params![target_id,wallpaper_id,name]
        ).map_err(|e| format!("Could not record active wallpaper: {e}"))?;
        tx.execute("INSERT INTO wallpaper_events (wallpaper_id,target_id,action,detail)
            VALUES (?1,?2,'apply',?3)",params![wallpaper_id,target_id,fit]
        ).map_err(|e| format!("Could not write wallpaper history: {e}"))?;
        tx.commit().map_err(|e| format!("Could not commit wallpaper history: {e}"))
    })();
    if let Err(error) = transaction_result {
        platform::restore(&before,&target_id);
        let _ = fs::remove_file(active);
        return Err(error);
    }
    for item in prior {
        if item.ends_with(".jpg") && item.chars()
            .all(|ch| ch.is_ascii_alphanumeric()||ch=='-'||ch=='.') {
            let _ = fs::remove_file(paths.active().join(item));
        }
    }
    Ok(ApplyResult {
        target_id, wallpaper_id,
        notice: format!("Applied {title} to Windows. Your saved Library original remains unchanged."),
    })
}

#[cfg(windows)]
mod platform {
    use super::MonitorInfo;
    use std::{ffi::{c_void,OsStr},os::windows::ffi::OsStrExt,path::Path};
    use windows::{
        core::{GUID,PCWSTR,PWSTR},
        Win32::{
            System::Com::{
                CLSCTX_LOCAL_SERVER,COINIT_APARTMENTTHREADED,CoCreateInstance,
                CoInitializeEx,CoTaskMemFree,CoUninitialize,
            },
            UI::Shell::{
                IDesktopWallpaper,DESKTOP_WALLPAPER_POSITION,DWPOS_CENTER,DWPOS_FILL,
                DWPOS_FIT,DWPOS_SPAN,DWPOS_STRETCH,
            },
        },
    };
    const CLSID: GUID = GUID::from_u128(0xC2CF3110_460E_4FC1_B9D0_8A1C0C9CC4BD);
    struct ComApartment;
    impl ComApartment {
        fn new() -> Result<Self,String> {
            unsafe { CoInitializeEx(None,COINIT_APARTMENTTHREADED) }
                .ok().map_err(|e| format!("Could not initialize Windows COM: {e}"))?;
            Ok(Self)
        }
    }
    impl Drop for ComApartment { fn drop(&mut self) { unsafe {CoUninitialize();} } }
    fn shell() -> Result<IDesktopWallpaper,String> {
        unsafe { CoCreateInstance(&CLSID,None,CLSCTX_LOCAL_SERVER) }
            .map_err(|e| format!("Windows desktop wallpaper service is unavailable: {e}"))
    }
    fn to_wide(input: &OsStr) -> Vec<u16> {
        input.encode_wide().chain(Some(0)).collect()
    }
    fn take_native(ptr: PWSTR) -> String {
        if ptr.is_null() { return String::new(); }
        let value = unsafe {ptr.to_string().unwrap_or_default()};
        unsafe {CoTaskMemFree(Some(ptr.0 as *const c_void));}
        value
    }
    pub fn monitors() -> Result<Vec<MonitorInfo>,String> {
        let _com = ComApartment::new()?;
        let wall = shell()?;
        let count = unsafe {wall.GetMonitorDevicePathCount()}
            .map_err(|e| format!("Could not count displays: {e}"))?;
        let mut results=Vec::new();
        for index in 0..count {
            let id = unsafe {wall.GetMonitorDevicePathAt(index)}.map(take_native)
                .map_err(|e| format!("Could not inspect display: {e}"))?;
            if id.is_empty() { continue; }
            let buf=to_wide(OsStr::new(&id));
            let Ok(rect)= (unsafe {wall.GetMonitorRECT(PCWSTR(buf.as_ptr()))}) else {continue;};
            let width = rect.right.saturating_sub(rect.left) as u32;
            let height= rect.bottom.saturating_sub(rect.top) as u32;
            if width==0||height==0 {continue;}
            results.push(MonitorInfo {
                id,name:format!("Display {} ({} × {})",results.len()+1,width,height),
                width,height,left:rect.left,top:rect.top,
                is_primary:rect.left==0&&rect.top==0,
            });
        }
        Ok(results)
    }
    pub struct Previous {
        path:String,position:DESKTOP_WALLPAPER_POSITION,
    }
    pub fn apply(
        file: &Path,target:&str,fit:&str,dimensions:(u32,u32),displays:&[MonitorInfo],
    ) -> Result<Previous,String> {
        let _com = ComApartment::new()?;
        let wall = shell()?;
        let selected = if target=="all" {None} else {
            Some(displays.iter().find(|m|m.id==target)
                .ok_or_else(||"Selected monitor is no longer connected.".to_string())?)
        };
        let id_buf=selected.map(|m|to_wide(OsStr::new(&m.id)));
        let id=id_buf.as_ref().map(|w|PCWSTR(w.as_ptr())).unwrap_or(PCWSTR::null());
        let old_path = unsafe{wall.GetWallpaper(id)}.map(take_native).unwrap_or_default();
        let old_position=unsafe{wall.GetPosition()}
            .map_err(|e|format!("Could not read previous wallpaper position: {e}"))?;
        let position=match fit {
            "fill"=>DWPOS_FILL,"fit"=>DWPOS_FIT,"stretch"=>DWPOS_STRETCH,
            "center"=>DWPOS_CENTER,"span"=>DWPOS_SPAN,
            "smartFit"=>{
                let src=dimensions.0 as f64/dimensions.1.max(1) as f64;
                let monitor_ratio=selected
                    .map(|m|m.width as f64/m.height.max(1) as f64)
                    .or_else(||displays.first().map(|m|m.width as f64/m.height.max(1) as f64))
                    .unwrap_or(16.0/9.0);
                if (src-monitor_ratio).abs() < 0.30 {DWPOS_FILL} else {DWPOS_FIT}
            },
            _=>return Err("Unsupported wallpaper fit.".into()),
        };
        unsafe{wall.SetPosition(position)}
            .map_err(|e|format!("Could not set desktop fit mode: {e}"))?;
        let path=to_wide(file.as_os_str());
        if let Err(e)=unsafe{wall.SetWallpaper(id,PCWSTR(path.as_ptr()))} {
            let _=unsafe{wall.SetPosition(old_position)};
            return Err(format!("Windows could not apply the wallpaper: {e}"));
        }
        Ok(Previous{path:old_path,position:old_position})
    }
    pub fn restore(previous:&Previous,target:&str) {
        if let Ok(_com)=ComApartment::new() {
            if let Ok(wall)=shell() {
                let target_buf=if target=="all"{None}else{Some(to_wide(OsStr::new(target)))};
                let ptr=target_buf.as_ref().map(|v|PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
                if !previous.path.is_empty(){
                    let old=to_wide(OsStr::new(&previous.path));
                    let _=unsafe{wall.SetWallpaper(ptr,PCWSTR(old.as_ptr()))};
                }
                let _=unsafe{wall.SetPosition(previous.position)};
            }
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::MonitorInfo;
    use std::path::Path;
    pub struct Previous;
    pub fn monitors()->Result<Vec<MonitorInfo>,String>{
        Err("Windows 10 or Windows 11 is required.".into())
    }
    pub fn apply(_:&Path,_:&str,_:&str,_:(u32,u32),_:&[MonitorInfo])->Result<Previous,String>{
        Err("Windows is required to apply wallpapers.".into())
    }
    pub fn restore(_: &Previous,_:&str){}
}
