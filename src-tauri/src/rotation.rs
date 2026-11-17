//! PR #7: opt-in Library rotation with verified public-domain offline reserve.
//! Discovery is bounded and never downloads from unapproved search providers.
use crate::{
    app_settings,
    local_storage::{self, DataPaths, StorageLock},
    windows_wallpaper::{self, ApplyResult},
    rotation_discovery,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

/// Serialize rotation preferences and rotation executions. The existing
/// StorageLock still owns all DB/file changes and Windows wallpaper writes.
#[derive(Default)]
pub struct RotationGate(pub Mutex<()>);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RotationPreferences {
    pub enabled: bool,
    pub paused: bool,
    pub pinned: bool,
    pub interval_minutes: u32,
    pub favorites_only: bool,
    pub cooldown_days: u32,
    pub discovery_enabled: bool,
    pub discovery_topics: Vec<String>,
    /// Read only for migration of the single-topic settings saved by the
    /// first Commit 2 version. New settings only serialize discoveryTopics.
    #[serde(rename = "discoveryTopic", default, skip_serializing)]
    pub legacy_discovery_topic: Option<String>,
}
impl Default for RotationPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            paused: false,
            pinned: false,
            interval_minutes: 1440,
            favorites_only: false,
            cooldown_days: 30,
            discovery_enabled: true,
            discovery_topics: rotation_discovery::DISCOVERY_TOPICS.iter()
                .map(|topic| (*topic).to_owned()).collect(),
            legacy_discovery_topic: None,
        }
    }
}
impl RotationPreferences {
    fn validate(&self) -> Result<(), String> {
        if !(15..=10080).contains(&self.interval_minutes) {
            return Err("Rotation interval must be between 15 minutes and 7 days.".into());
        }
        if !(1..=365).contains(&self.cooldown_days) {
            return Err("No-repeat period must be between 1 and 365 days.".into());
        }
        if self.discovery_topics.is_empty() ||
            self.discovery_topics.len() > rotation_discovery::DISCOVERY_TOPICS.len() {
            return Err("Select at least one automatic discovery topic.".into());
        }
        let mut seen = HashSet::new();
        for topic in &self.discovery_topics {
            if !rotation_discovery::DISCOVERY_TOPICS.contains(&topic.as_str())
                || !seen.insert(topic) {
                return Err("Automatic discovery topics contain an unsupported or repeated option.".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredRotation {
    preferences: RotationPreferences,
    next_due_unix: Option<i64>,
    last_success_unix: Option<i64>,
    last_wallpaper_id: Option<String>,
    last_error: Option<String>,
    next_discovery_unix: Option<i64>,
    last_discovery_error: Option<String>,
    last_discovery_topic: Option<String>,
    last_discovery_unix: Option<i64>,
    last_discovery_outcome: Option<String>,
    /// Cursor across topic × result-page combinations.
    discovery_page: u32,
}
impl Default for StoredRotation {
    fn default() -> Self {
        Self {
            preferences: RotationPreferences::default(),
            next_due_unix: None,
            last_success_unix: None,
            last_wallpaper_id: None,
            last_error: None,
            next_discovery_unix: None,
            last_discovery_error: None,
            last_discovery_topic: None,
            last_discovery_unix: None,
            last_discovery_outcome: None,
            discovery_page: 0,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationStatus {
    preferences: RotationPreferences,
    next_due_unix: Option<i64>,
    last_success_unix: Option<i64>,
    last_wallpaper_id: Option<String>,
    last_error: Option<String>,
    eligible_count: usize,
    reserve_count: usize,
    next_discovery_unix: Option<i64>,
    last_discovery_error: Option<String>,
    last_discovery_topic: Option<String>,
    last_discovery_unix: Option<i64>,
    last_discovery_outcome: Option<String>,
}
impl RotationStatus {
    fn from_store(stored: StoredRotation, eligible_count: usize, reserve_count: usize) -> Self {
        Self {
            preferences: stored.preferences,
            next_due_unix: stored.next_due_unix,
            last_success_unix: stored.last_success_unix,
            last_wallpaper_id: stored.last_wallpaper_id,
            last_error: stored.last_error,
            eligible_count,
            reserve_count,
            next_discovery_unix: stored.next_discovery_unix,
            last_discovery_error: stored.last_discovery_error,
            last_discovery_topic: stored.last_discovery_topic,
            last_discovery_unix: stored.last_discovery_unix,
            last_discovery_outcome: stored.last_discovery_outcome,
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO).as_secs() as i64
}
fn next_due(now: i64, interval_minutes: u32) -> i64 {
    now.saturating_add(i64::from(interval_minutes) * 60)
}
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rotation_settings (
             id INTEGER PRIMARY KEY CHECK(id=1),
             json TEXT NOT NULL
         );"
    ).map_err(|e| format!("Could not initialize rotation settings: {e}"))?;
    Ok(())
}
fn load(conn: &Connection) -> Result<StoredRotation, String> {
    ensure_schema(conn)?;
    let fallback = serde_json::to_string(&StoredRotation::default())
        .map_err(|e| format!("Could not initialize rotation defaults: {e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO rotation_settings(id,json) VALUES(1,?1)",
        params![fallback],
    ).map_err(|e| format!("Could not prepare rotation settings: {e}"))?;
    let json: String = conn.query_row(
        "SELECT json FROM rotation_settings WHERE id=1", [], |row| row.get(0),
    ).map_err(|e| format!("Could not read rotation settings: {e}"))?;
    let mut state: StoredRotation = serde_json::from_str(&json)
        .map_err(|e| format!("Saved rotation settings are invalid: {e}"))?;
    // Previous Commit 2 saved a single discoveryTopic. Preserve that user's
    // choice instead of silently opting their existing installation into
    // seven additional categories. New installs default to all eight.
    let has_topics = serde_json::from_str::<serde_json::Value>(&json).ok()
        .and_then(|value| value.pointer("/preferences/discoveryTopics").cloned())
        .is_some();
    if !has_topics {
        if let Some(old) = state.preferences.legacy_discovery_topic.as_ref() {
            if rotation_discovery::DISCOVERY_TOPICS.contains(&old.as_str()) {
                state.preferences.discovery_topics = vec![old.clone()];
            }
        }
    }
    state.preferences.legacy_discovery_topic = None;
    state.preferences.validate()?;
    Ok(state)
}
fn save(conn: &Connection, state: &StoredRotation) -> Result<(), String> {
    state.preferences.validate()?;
    let json = serde_json::to_string(state)
        .map_err(|e| format!("Could not serialize rotation settings: {e}"))?;
    conn.execute(
        "UPDATE rotation_settings SET json=?1 WHERE id=1",
        params![json],
    ).map_err(|e| format!("Could not persist rotation settings: {e}"))?;
    Ok(())
}

#[derive(Clone)]
struct Candidate {
    id: String,
    last_used_unix: i64,
}

/// Prefer an unused or cooled-down item; when the pool is small, reuse the
/// *least recently used* image, but never reapply the already assigned image.
fn choose_next(candidates: &[Candidate], current: &HashSet<String>,
               now: i64, cooldown_days: u32) -> Option<String> {
    let cutoff = now.saturating_sub(i64::from(cooldown_days) * 86400);
    let mut available: Vec<&Candidate> = candidates.iter()
        .filter(|candidate| !current.contains(&candidate.id)).collect();
    available.sort_by(|a, b| a.last_used_unix.cmp(&b.last_used_unix)
        .then(a.id.cmp(&b.id)));
    available.iter().find(|image|
        image.last_used_unix == 0 || image.last_used_unix <= cutoff
    ).or_else(|| available.first()).map(|image| image.id.clone())
}

fn candidates(conn: &Connection, paths: &DataPaths,
              favorites_only: bool) -> Result<Vec<Candidate>, String> {
    let settings = app_settings::read_settings(conn)?;
    let (min_long, min_short) = match settings.minimum_resolution.as_str() {
        "1440p" => (2560, 1440),
        "4K" => (3840, 2160),
        _ => (1920, 1080),
    };
    let mut stmt = conn.prepare(
        "SELECT w.id, w.width, w.height, f.relative_path,
                COALESCE(CAST(strftime('%s', MAX(e.event_time)) AS INTEGER), 0)
         FROM wallpapers w
         JOIN wallpaper_files f ON f.wallpaper_id=w.id AND f.storage_class='managed'
         LEFT JOIN wallpaper_events e ON e.wallpaper_id=w.id AND e.action='apply'
         WHERE (?1=0 OR w.favorite=1)
         GROUP BY w.id, w.width, w.height, f.relative_path
         ORDER BY w.created_at DESC, w.id ASC LIMIT 500"
    ).map_err(|e| format!("Could not inspect Library rotation candidates: {e}"))?;
    let rows = stmt.query_map(params![favorites_only], |row| {
        Ok((
            row.get::<_, String>(0)?, row.get::<_, u32>(1)?,
            row.get::<_, u32>(2)?, row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }).map_err(|e| format!("Could not list Library rotation candidates: {e}"))?;
    let mut result = Vec::new();
    for row in rows {
        let (id, width, height, filename, last_used_unix) =
            row.map_err(|e| format!("Could not inspect Library image: {e}"))?;
        // Automatic selection must not bypass the saved quality threshold.
        // Only landscape Library originals are eligible for this first version.
        if width < height || width < min_long || height < min_short { continue; }
        if !["jpg", "png", "webp"].iter().any(|ext|
            filename == format!("{id}.{ext}")) { continue; }
        if !paths.library().join(filename).is_file() { continue; }
        result.push(Candidate { id, last_used_unix });
    }
    Ok(result)
}
fn reserve_candidates(conn: &Connection, paths: &DataPaths) -> Result<Vec<Candidate>, String> {
    let settings = app_settings::read_settings(conn)?;
    let (min_width, min_height) = match settings.minimum_resolution.as_str() {
        "1440p" => (2560, 1440),
        "4K" => (3840, 2160),
        _ => (1920, 1080),
    };
    let mut stmt = conn.prepare(
        "SELECT w.id,w.width,w.height,f.relative_path,
           COALESCE(CAST(strftime('%s', MAX(e.event_time)) AS INTEGER),0)
         FROM wallpapers w JOIN wallpaper_files f
           ON f.wallpaper_id=w.id AND f.storage_class='reserve'
         LEFT JOIN wallpaper_events e ON e.wallpaper_id=w.id AND e.action='apply'
         GROUP BY w.id,w.width,w.height,f.relative_path
         ORDER BY w.created_at,w.id LIMIT 100"
    ).map_err(|e| format!("Could not inspect offline reserve: {e}"))?;
    let rows = stmt.query_map([], |row| Ok((
        row.get::<_,String>(0)?, row.get::<_,u32>(1)?,
        row.get::<_,u32>(2)?, row.get::<_,String>(3)?,
        row.get::<_,i64>(4)?
    ))).map_err(|e| format!("Could not read offline reserve: {e}"))?;
    let mut pool = Vec::new();
    for row in rows {
        let (id,w,h,filename,last_used_unix) =
            row.map_err(|e| format!("Could not inspect reserve file: {e}"))?;
        if w < min_width || h < min_height || w < h { continue; }
        if !["jpg","png","webp"].iter().any(|ext|
            filename == format!("{id}.{ext}")) { continue; }
        if !paths.offline_reserve().join(filename).is_file() { continue; }
        pool.push(Candidate { id, last_used_unix });
    }
    Ok(pool)
}

fn active_ids(conn: &Connection) -> Result<HashSet<String>, String> {
    // The existing apply path initializes this table; a fresh installation
    // without an applied wallpaper may not have it yet.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS active_assignments (
            target_id TEXT PRIMARY KEY,
            wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE RESTRICT,
            relative_path TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );"
    ).map_err(|e| format!("Could not inspect current wallpaper assignments: {e}"))?;
    let mut stmt = conn.prepare("SELECT DISTINCT wallpaper_id FROM active_assignments")
        .map_err(|e| format!("Could not inspect current wallpaper IDs: {e}"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Could not read current wallpaper IDs: {e}"))?;
    let mut ids = HashSet::new();
    for row in rows {
        ids.insert(row.map_err(|e| format!("Could not read assigned wallpaper: {e}"))?);
    }
    Ok(ids)
}

fn with_storage<T>(app: &AppHandle,
    f: impl FnOnce(&Connection, &DataPaths) -> Result<T, String>
) -> Result<T, String> {
    let storage = app.state::<StorageLock>();
    let _guard = storage.0.lock().map_err(|_| "Storage is busy".to_string())?;
    let paths = local_storage::current_paths(app)?;
    local_storage::prepare_folders(&paths)?;
    let conn = app_settings::open_database(&paths)?;
    f(&conn, &paths)
}

#[tauri::command]
pub fn get_rotation_status(app: AppHandle) -> Result<RotationStatus, String> {
    with_storage(&app, |conn, paths| {
        let stored = load(conn)?;
        let library = candidates(conn, paths, stored.preferences.favorites_only)?.len();
        let reserve = reserve_candidates(conn, paths)?.len();
        let eligible = library + if stored.preferences.favorites_only { 0 } else { reserve };
        Ok(RotationStatus::from_store(stored, eligible, reserve))
    })
}

#[tauri::command]
pub fn save_rotation_preferences(
    app: AppHandle, preferences: RotationPreferences,
) -> Result<RotationStatus, String> {
    preferences.validate()?;
    let gate = app.state::<RotationGate>();
    let _gate = gate.0.lock().map_err(|_| "Rotation is busy".to_string())?;
    with_storage(&app, |conn, paths| {
        let mut state = load(conn)?;
        let before = state.preferences.clone();
        let now = now_unix();
        if !preferences.enabled {
            state.next_due_unix = None;
        } else if !before.enabled || preferences.interval_minutes != before.interval_minutes {
            state.next_due_unix = Some(next_due(now, preferences.interval_minutes));
        } else if (!preferences.paused && !preferences.pinned)
            && (before.paused || before.pinned)
            && state.next_due_unix.unwrap_or(now) <= now {
            // Unpin/resume should not immediately trigger missed rotations.
            state.next_due_unix = Some(next_due(now, preferences.interval_minutes));
        } else if state.next_due_unix.is_none() {
            state.next_due_unix = Some(next_due(now, preferences.interval_minutes));
        }
        if !preferences.enabled || !preferences.discovery_enabled {
            state.next_discovery_unix = None;
        } else if !before.enabled || !before.discovery_enabled
            || before.discovery_topics != preferences.discovery_topics {
            state.next_discovery_unix = Some(now);
            state.discovery_page = 0;
            state.last_discovery_error = None;
        }
        state.preferences = preferences;
        if before != state.preferences { state.last_error = None; }
        save(conn, &state)?;
        let library = candidates(conn, paths, state.preferences.favorites_only)?.len();
        let reserve = reserve_candidates(conn, paths)?.len();
        let eligible = library + if state.preferences.favorites_only { 0 } else { reserve };
        Ok(RotationStatus::from_store(state, eligible, reserve))
    })
}

/// Called by the existing Windows apply path under StorageLock after a
/// successful COM apply and database commit. Manual Set Now resets the
/// interval, without triggering a separate wallpaper write.
pub(crate) fn note_successful_apply(conn: &Connection, id: &str) -> Result<(), String> {
    let mut state = load(conn)?;
    let now = now_unix();
    state.last_success_unix = Some(now);
    state.last_wallpaper_id = Some(id.to_owned());
    state.last_error = None;
    if state.preferences.enabled {
        state.next_due_unix = Some(next_due(now, state.preferences.interval_minutes));
    }
    save(conn, &state)
}

/// One page of each selected topic per round, then advance to the next page.
/// Never send multiple topic requests during a single replenishment attempt.
fn discovery_turn(topics: &[String], cursor: u32) -> (String, u32) {
    let count = topics.len() as u32;
    (topics[(cursor % count) as usize].clone(), (cursor / count) % 20)
}

// Replenishment and manual Next share RotationGate to avoid concurrent
// duplicate downloads; downloads do NOT hold StorageLock.
fn maybe_replenish(app: &AppHandle, now: i64, force: bool) -> Result<(), String> {
    let action = with_storage(app, |conn, paths| {
        let state = load(conn)?;
        if !state.preferences.enabled || !state.preferences.discovery_enabled ||
            state.preferences.favorites_only ||
            reserve_candidates(conn, paths)?.len() >= rotation_discovery::RESERVE_TARGET {
            return Ok(None);
        }
        if !force && state.next_discovery_unix.is_some_and(|due| due > now) {
            return Ok(None);
        }
        // Visit page zero of each selected topic before moving to page one.
        // Rotate one provider request per replenishment cycle, not a burst
        // of concurrent queries or downloads.
        let topics = &state.preferences.discovery_topics;
        let topic_count = topics.len() as u32;
        let (topic, page) = discovery_turn(topics, state.discovery_page);
        Ok(Some((topic, page, state.discovery_page, topic_count)))
    })?;
    let Some((topic, page, cursor, topic_count)) = action else { return Ok(()); };
    let result = rotation_discovery::replenish_once(app, &topic, page);
    let finished = now_unix();
    with_storage(app, |conn, _| {
        let mut state = load(conn)?;
        state.discovery_page = (cursor + 1) % (topic_count * 20);
        state.next_discovery_unix = Some(finished.saturating_add(match &result {
            Ok(true) => 60, // one source file at a time to avoid API bursts
            Ok(false) => 300,
            Err(_) => 900, // back off on rate limits and failures
        }));
        state.last_discovery_error = match &result {
            Err(message) => Some(message.clone()),
            _ => None,
        };
        state.last_discovery_topic = Some(topic);
        state.last_discovery_unix = Some(finished);
        state.last_discovery_outcome = Some(match &result {
            Ok(true) => "saved",
            Ok(false) => "no_match",
            Err(_) => "error",
        }.to_owned());
        save(conn, &state)
    })?;
    Ok(())
}

fn select_candidate(app: &AppHandle, now: i64, force: bool)
    -> Result<Option<String>, String> {
    with_storage(app, |conn, paths| {
        let state = load(conn)?;
        if state.preferences.pinned {
            if force { return Err("Unpin the current wallpaper before choosing Next.".into()); }
            return Ok(None);
        }
        if !force && (!state.preferences.enabled || state.preferences.paused
            || state.next_due_unix.map(|due| due > now).unwrap_or(true)) {
            return Ok(None);
        }
        let current = active_ids(conn)?;
        let library = candidates(conn, paths, state.preferences.favorites_only)?;
        if let Some(id) = choose_next(&library, &current, now, state.preferences.cooldown_days) {
            return Ok(Some(id));
        }
        if !state.preferences.favorites_only {
            let reserve = reserve_candidates(conn, paths)?;
            if let Some(id) = choose_next(&reserve, &current, now, state.preferences.cooldown_days) {
                return Ok(Some(id));
            }
        }
        Err("No other eligible wallpaper. Add a landscape image to Library or enable automatic discovery to replenish your offline reserve.".into())
    })
}

fn rotate_sync(app: &AppHandle, force: bool) -> Result<Option<ApplyResult>, String> {
    let gate = app.state::<RotationGate>();
    let _gate = gate.0.lock().map_err(|_| "Rotation is busy".to_string())?;
    let now = now_unix();
    // Background polling refills the reserve independently of rotation.
    // A manual Next with no eligible item makes one immediate attempt below,
    // not two redundant Commons requests for the same image.
    if !force { let _ = maybe_replenish(app, now, false); }
    let mut choice = select_candidate(app, now, force);
    // Next with an empty pool can try discovery immediately instead of
    // asking the user to wait for the next scheduled source refresh.
    if force && choice.is_err() {
        let _ = maybe_replenish(app, now, true);
        choice = select_candidate(app, now, force);
    }
    let selected = match choice {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(None),
        Err(message) => {
            if !force {
                let _ = with_storage(app, |conn, _| {
                    let mut state = load(conn)?;
                    state.last_error = Some(message.clone());
                    state.next_due_unix = Some(now.saturating_add(900));
                    save(conn, &state)
                });
                return Ok(None);
            }
            return Err(message);
        }
    };
    // Reuse the one proven Windows wallpaper pipeline. It serializes file
    // writes, preserves managed originals and records an apply history event.
    let result = windows_wallpaper::apply_sync(
        app, selected.clone(), "all".into(), None, None,
    );
    match result {
        Ok(applied) => {
            // note_successful_apply already advanced the schedule in apply_sync.
            let _ = app.emit("rotation:applied", &applied);
            Ok(Some(applied))
        }
        Err(message) => {
            let _ = with_storage(app, |conn, _| {
                let mut state = load(conn)?;
                state.last_error = Some(message.clone());
                if state.preferences.enabled {
                    state.next_due_unix = Some(now.saturating_add(900));
                }
                save(conn, &state)
            });
            if force { Err(message) } else { Ok(None) }
        }
    }
}
#[tauri::command]
pub async fn rotation_next(app: AppHandle) -> Result<ApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || rotate_sync(&app, true))
        .await.map_err(|_| "Wallpaper rotation was interrupted.".to_string())?
        .and_then(|result| result.ok_or_else(|| "No wallpaper was selected.".to_string()))
}

/// One scheduler per app process. Commit 3 will keep the process alive in
/// the system tray; this initial version only runs while Haven Walls is open.
pub fn start(app: AppHandle) {
    // The Rust worker runs independently of the React window and never
    // performs network requests. Commit 3 adds the keep-running tray behavior.
    let _ = std::thread::Builder::new()
        .name("haven-rotation".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let _ = rotate_sync(&app, false);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(id: &str, used: i64) -> Candidate {
        Candidate { id: id.into(), last_used_unix: used }
    }
    #[test]
    fn default_is_opt_in_and_daily() {
        let defaults = RotationPreferences::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.interval_minutes, 1440);
        assert_eq!(defaults.cooldown_days, 30);
    }
    #[test]
    fn topics_default_to_all_and_reject_empty_duplicates_unknown() {
        let mut p = RotationPreferences::default();
        assert_eq!(p.discovery_topics.len(), rotation_discovery::DISCOVERY_TOPICS.len());
        p.discovery_topics.clear();
        assert!(p.validate().is_err());
        p.discovery_topics = vec!["space".into(), "space".into()];
        assert!(p.validate().is_err());
        p.discovery_topics = vec!["sports".into()];
        assert!(p.validate().is_err());
        p.discovery_topics = vec!["oceans".into(), "mountains".into()];
        assert!(p.validate().is_ok());
    }
    #[test]
    fn upgrades_saved_single_topic_preference_without_changing_choice() {
        let conn = Connection::open_in_memory().unwrap();
        let _ = load(&conn).unwrap();
        conn.execute("UPDATE rotation_settings SET json=?1 WHERE id=1",
            params![r#"{"preferences":{"discoveryTopic":"space","enabled":true}}"#]
        ).unwrap();
        let old = load(&conn).unwrap();
        assert_eq!(old.preferences.discovery_topics, vec!["space"]);
        save(&conn, &old).unwrap();
        let new = load(&conn).unwrap();
        assert_eq!(new.preferences.discovery_topics, vec!["space"]);
        assert!(!serde_json::to_string(&new).unwrap().contains("\"discoveryTopic\""));
    }
    #[test]
    fn rotates_selected_topics_before_advancing_pages() {
        let topics = vec!["mountains".to_owned(), "space".to_owned(), "oceans".to_owned()];
        assert_eq!(discovery_turn(&topics, 0), ("mountains".into(), 0));
        assert_eq!(discovery_turn(&topics, 1), ("space".into(), 0));
        assert_eq!(discovery_turn(&topics, 2), ("oceans".into(), 0));
        assert_eq!(discovery_turn(&topics, 3), ("mountains".into(), 1));
        assert_eq!(discovery_turn(&topics, 60), ("mountains".into(), 0));
    }
    #[test]
    fn invalid_intervals_and_cooldowns_are_rejected() {
        let mut p = RotationPreferences::default();
        p.interval_minutes = 0;
        assert!(p.validate().is_err());
        p.interval_minutes = 10081;
        assert!(p.validate().is_err());
        p.interval_minutes = 60;
        p.cooldown_days = 366;
        assert!(p.validate().is_err());
    }
    #[test]
    fn respects_current_and_cooldown_then_falls_back() {
        let now = 2_000_000_000;
        let pool = vec![image("old", now - 40 * 86400),
            image("new", now - 1 * 86400), image("unused", 0)];
        let active = HashSet::from(["unused".to_owned()]);
        assert_eq!(choose_next(&pool, &active, now, 30).as_deref(), Some("old"));
        let active = HashSet::from(["old".to_owned(), "unused".to_owned()]);
        assert_eq!(choose_next(&pool, &active, now, 30).as_deref(), Some("new"));
        assert_eq!(choose_next(&pool, &HashSet::from(["new".to_owned(), "old".to_owned(), "unused".to_owned()]), now, 30), None);
    }
    #[test]
    fn sqlite_defaults_and_persistence() {
        let conn = Connection::open_in_memory().unwrap();
        let mut state = load(&conn).unwrap();
        assert!(!state.preferences.enabled);
        state.preferences.enabled = true;
        state.next_due_unix = Some(12345);
        save(&conn, &state).unwrap();
        let again = load(&conn).unwrap();
        assert!(again.preferences.enabled);
        assert_eq!(again.next_due_unix, Some(12345));
    }
}
