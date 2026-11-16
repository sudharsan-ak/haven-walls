//! Commit 2: browser session, visits and bookmarks in Haven Walls' existing
//! SQLite DB. This is app-owned data, never stored in source/build files.
//! Website cookies and other WebView2 profile data live in browser-profile/
//! and are managed by WebView2, not copied into SQLite.
use std::collections::HashSet;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{app_settings, local_storage::{self, StorageLock}};

const MAX_TABS: usize = 12;
const MAX_TITLE: usize = 180;
const MAX_FOLDER: usize = 60;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub id: String,
    pub url: String,
    pub title: String,
    // Old sessions had no zoom field. Keep them readable across upgrades.
    #[serde(default = "default_zoom_percent")]
    pub zoom: u16,
}
fn default_zoom_percent() -> u16 { 100 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub selected_id: String,
    pub tabs: Vec<SavedTab>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmark {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub folder: String,
    pub created_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVisit {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub visited_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserData {
    pub session: Option<BrowserSession>,
    pub bookmarks: Vec<BrowserBookmark>,
    pub history: Vec<BrowserVisit>,
}

pub(crate) fn database(app: &AppHandle) -> Result<Connection, String> {
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    app_settings::open_database(&paths)
}

fn valid_url(raw: &str) -> bool {
    if raw.len() > 8192 { return false; }
    tauri::Url::parse(raw).is_ok_and(|url|
        matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
    )
}
fn clean_title(text: &str) -> String {
    let trimmed: String = text.trim().chars().take(MAX_TITLE).collect();
    if trimmed.is_empty() { "Untitled page".into() } else { trimmed }
}
fn clean_folder(text: &str) -> String {
    let trimmed: String = text.trim().chars().take(MAX_FOLDER).collect();
    if trimmed.is_empty() { "Favorites".into() } else { trimmed }
}
fn valid_session(session: &BrowserSession) -> Result<(), String> {
    if session.tabs.is_empty() || session.tabs.len() > MAX_TABS {
        return Err("A browser session must contain between 1 and 12 tabs.".into());
    }
    let mut seen = HashSet::new();
    for tab in &session.tabs {
        if tab.id.is_empty() || tab.id.len() > 36
            || !tab.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !seen.insert(tab.id.as_str()) {
            return Err("Browser session contains a duplicate or invalid tab ID.".into());
        }
        if !valid_url(&tab.url) || tab.title.chars().count() > MAX_TITLE
            || !(50..=200).contains(&tab.zoom) {
            return Err("Browser session contains an invalid website or tab title.".into());
        }
    }
    if !seen.contains(session.selected_id.as_str()) {
        return Err("The selected browser tab is missing from the session.".into());
    }
    Ok(())
}
fn bookmarks(conn: &Connection) -> Result<Vec<BrowserBookmark>, String> {
    let mut query = conn.prepare(
        "SELECT id, url, title, folder, created_at FROM browser_bookmarks
         ORDER BY folder COLLATE NOCASE, title COLLATE NOCASE, id"
    ).map_err(|_| "Could not read browser bookmarks.".to_string())?;
    let rows = query.query_map([], |row| Ok(BrowserBookmark {
        id: row.get(0)?, url: row.get(1)?, title: row.get(2)?,
        folder: row.get(3)?, created_at: row.get(4)?,
    })).map_err(|_| "Could not list browser bookmarks.".to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Could not decode browser bookmarks.".to_string())
}
fn history(conn: &Connection) -> Result<Vec<BrowserVisit>, String> {
    let mut query = conn.prepare(
        "SELECT id, url, title, visited_at FROM browser_history
         ORDER BY id DESC LIMIT 500"
    ).map_err(|_| "Could not read browser history.".to_string())?;
    let rows = query.query_map([], |row| Ok(BrowserVisit {
        id: row.get(0)?, url: row.get(1)?,
        title: row.get(2)?, visited_at: row.get(3)?,
    })).map_err(|_| "Could not list browser history.".to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Could not decode browser history.".to_string())
}

#[tauri::command]
pub fn browser_load_data(app: AppHandle, state: State<'_, StorageLock>)
    -> Result<BrowserData, String> {
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(&app)?;
    let json: Option<String> = conn.query_row(
        "SELECT json FROM browser_session WHERE id=1", [],
        |row| row.get(0),
    ).optional().map_err(|_| "Could not load the previous browser tabs.".to_string())?;
    // Decode and validate directly. Avoid an intermediate Result in a
    // map/transpose closure, whose error type Rust cannot infer here.
    let session: Option<BrowserSession> = match json {
        Some(data) => {
            let restored: BrowserSession = serde_json::from_str(&data)
                .map_err(|_| "Saved browser session is unreadable.".to_string())?;
            valid_session(&restored)?;
            Some(restored)
        }
        None => None,
    };
    Ok(BrowserData { session, bookmarks: bookmarks(&conn)?, history: history(&conn)? })
}
#[tauri::command]
pub fn browser_save_session(app: AppHandle, state: State<'_, StorageLock>,
    session: BrowserSession) -> Result<(), String> {
    valid_session(&session)?;
    let json = serde_json::to_string(&session)
        .map_err(|_| "Could not serialize browser tabs.".to_string())?;
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(&app)?;
    conn.execute(
        "INSERT INTO browser_session(id,json) VALUES (1,?1)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![json],
    ).map_err(|_| "Could not save browser tabs.".to_string())?;
    Ok(())
}

/// Called after native WebView2 finishes a page load, off the UI thread.
/// History stores metadata only, not cookies, page content, or form data.
pub fn record_visit(app: &AppHandle, url: &str) -> Result<(), String> {
    if !valid_url(url) { return Ok(()); }
    let state = app.state::<StorageLock>();
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(app)?;
    conn.execute(
        "INSERT INTO browser_history(url,title) VALUES(?1,?2)",
        params![url, tauri::Url::parse(url).ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| "Website".into())],
    ).map_err(|_| "Could not record browser history.".to_string())?;
    // Bound history growth. Keep the most recent 1500 records.
    conn.execute(
        "DELETE FROM browser_history WHERE id NOT IN (
             SELECT id FROM browser_history ORDER BY id DESC LIMIT 1500
         )", [],
    ).map_err(|_| "Could not trim browser history.".to_string())?;
    Ok(())
}
#[tauri::command]
pub fn browser_add_bookmark(app: AppHandle, state: State<'_, StorageLock>,
    url: String, title: String, folder: String) -> Result<Vec<BrowserBookmark>, String> {
    if !valid_url(&url) { return Err("Choose a valid website to bookmark.".into()); }
    let title = clean_title(&title);
    let folder = clean_folder(&folder);
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(&app)?;
    conn.execute(
        "INSERT INTO browser_bookmarks(url,title,folder) VALUES(?1,?2,?3)
         ON CONFLICT(url) DO UPDATE SET title=excluded.title,folder=excluded.folder",
        params![url,title,folder],
    ).map_err(|_| "Could not save this bookmark.".to_string())?;
    bookmarks(&conn)
}
#[tauri::command]
pub fn browser_remove_bookmark(app: AppHandle, state: State<'_, StorageLock>,
    id: i64) -> Result<Vec<BrowserBookmark>, String> {
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(&app)?;
    conn.execute("DELETE FROM browser_bookmarks WHERE id=?1", params![id])
        .map_err(|_| "Could not remove this bookmark.".to_string())?;
    bookmarks(&conn)
}
#[tauri::command]
pub fn browser_clear_history(app: AppHandle, state: State<'_, StorageLock>)
    -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "Browser storage is unavailable.".to_string())?;
    let conn = database(&app)?;
    conn.execute("DELETE FROM browser_history", [])
        .map_err(|_| "Could not clear browser history.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_session_and_rejects_local_addresses() {
        let mut s = BrowserSession { selected_id: "tab-one".into(), tabs: vec![
            SavedTab { id: "tab-one".into(), url: "https://www.google.com/".into(),
                title: "Google".into(), zoom: 100 },
        ] };
        assert!(valid_session(&s).is_ok());
        s.tabs[0].url = "file:///C:/Windows/system.ini".into();
        assert!(valid_session(&s).is_err());
    }
    #[test]
    fn older_sessions_default_to_full_zoom() {
        let old = r#"{"selectedId":"t-1","tabs":[{"id":"t-1","url":"https://example.com/","title":"Example"}]}"#;
        let session: BrowserSession = serde_json::from_str(old).expect("older session");
        assert_eq!(session.tabs[0].zoom, 100);
        assert!(valid_session(&session).is_ok());
    }
    #[test]
    fn rejects_out_of_range_zoom() {
        let mut session = BrowserSession {
            selected_id: "t-1".into(),
            tabs: vec![SavedTab { id: "t-1".into(), url: "https://example.com/".into(),
                title: "Example".into(), zoom: 210 }],
        };
        assert!(valid_session(&session).is_err());
        session.tabs[0].zoom = 50;
        assert!(valid_session(&session).is_ok());
    }
    #[test]
    fn rejects_missing_selected_tab_and_duplicates() {
        let original = SavedTab {
            id: "first".into(), url: "https://example.com/".into(), title: "Example".into(),
            zoom: 100
        };
        let mut s = BrowserSession { selected_id: "missing".into(), tabs: vec![original.clone()] };
        assert!(valid_session(&s).is_err());
        s.selected_id = "first".into();
        s.tabs.push(original);
        assert!(valid_session(&s).is_err());
    }
}
