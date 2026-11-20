//! PR #7: opt-in Library rotation with verified public-domain offline reserve.
//! Discovery is bounded and never downloads from unapproved search providers.
use crate::{
    app_settings,
    local_storage::{self, DataPaths, StorageLock},
    windows_wallpaper::{self, ApplyResult},
    rotation_discovery,
};
use rusqlite::{params, params_from_iter, types::Value, Connection};
use chrono::{Days, Duration as ChronoDuration, Local, LocalResult, NaiveTime, TimeZone};
#[cfg(test)]
use chrono::Timelike;
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
    /// "all" rotates Library + offline reserve; "collections" restricts to
    /// managed Library files in the selected collections (no reserve fallback).
    pub rotation_scope: String,
    pub collection_ids: Vec<String>,
    pub cooldown_days: u32,
    pub schedule_mode: String,
    pub daily_time: String,
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
            rotation_scope: "all".into(),
            collection_ids: Vec::new(),
            cooldown_days: 30,
            schedule_mode: "interval".into(),
            daily_time: "09:00".into(),
            discovery_enabled: true,
            discovery_topics: rotation_discovery::DISCOVERY_TOPICS.iter()
                .map(|topic| (*topic).to_owned()).collect(),
            legacy_discovery_topic: None,
        }
    }
}
impl RotationPreferences {
    fn validate(&self) -> Result<(), String> {
        if self.rotation_scope != "all" && self.rotation_scope != "collections" {
            return Err("Choose Entire Library or Selected collections for rotation.".into());
        }
        if self.collection_ids.len() > 100 ||
            self.collection_ids.iter().any(|id| id.is_empty() || id.len() > 128) ||
            self.collection_ids.iter().collect::<HashSet<_>>().len() != self.collection_ids.len() {
            return Err("Rotation collections contain an invalid or duplicate ID.".into());
        }
        if self.rotation_scope == "collections" && self.collection_ids.is_empty() {
            return Err("Select at least one collection before enabling collection rotation.".into());
        }
        if !(15..=10080).contains(&self.interval_minutes) {
            return Err("Rotation interval must be between 15 minutes and 7 days.".into());
        }
        if !(1..=365).contains(&self.cooldown_days) {
            return Err("No-repeat period must be between 1 and 365 days.".into());
        }
        if self.schedule_mode != "interval" && self.schedule_mode != "daily" {
            return Err("Choose interval or daily rotation scheduling.".into());
        }
        if self.daily_time.len() != 5 ||
            NaiveTime::parse_from_str(&self.daily_time, "%H:%M").is_err() {
            return Err("Daily rotation time must be HH:MM (local Windows time).".into());
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
    /// Consecutive failed attempts, persisted across app restarts.
    discovery_failures: u32,
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
            discovery_failures: 0,
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

/// The next local wall-clock occurrence, including DST gap and overlap cases.
fn schedule_next(now: i64, preferences: &RotationPreferences) -> i64 {
    if preferences.schedule_mode != "daily" {
        return next_due(now, preferences.interval_minutes);
    }
    let Ok(time) = NaiveTime::parse_from_str(&preferences.daily_time, "%H:%M") else {
        return next_due(now, preferences.interval_minutes);
    };
    let today = Local.timestamp_opt(now, 0)
        .single().unwrap_or_else(Local::now).date_naive();
    for offset in 0..4 {
        let Some(day) = today.checked_add_days(Days::new(offset)) else { break; };
        let mut naive = day.and_time(time);
        for _ in 0..181 {
            let candidate = match Local.from_local_datetime(&naive) {
                LocalResult::Single(date) => Some(date.timestamp()),
                LocalResult::Ambiguous(a, b) =>
                    [a.timestamp(), b.timestamp()].into_iter()
                        .filter(|value| *value > now).min(),
                LocalResult::None => None,
            };
            if let Some(timestamp) = candidate {
                if timestamp > now { return timestamp; }
                break;
            }
            // During spring-forward, use the first valid clock minute.
            naive += ChronoDuration::minutes(1);
        }
    }
    next_due(now, 1440)
}
/// When the Windows clock or timezone moves, a future daily deadline may
/// belong to the *old* timezone. Realign it once, but never discard a past
/// deadline: after sleep/wake, an overdue change should still occur once.
fn adjusted_daily_due(
    now: i64, due: Option<i64>, prefs: &RotationPreferences, last_error: Option<&str>,
) -> Option<i64> {
    if !prefs.enabled || prefs.schedule_mode != "daily" || last_error.is_some() {
        return None;
    }
    let deadline = due?;
    if deadline <= now { return None; }
    let expected = schedule_next(now, prefs);
    if expected.abs_diff(deadline) > 60 { Some(expected) } else { None }
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

/// Check selected IDs when saving. Deleting a collection later does not
/// silently switch the saved preference to "all"; the rotation pool becomes
/// empty until the user explicitly adjusts their collection selection.
fn validate_selected_collections(
    conn: &Connection, preferences: &RotationPreferences,
) -> Result<(), String> {
    if preferences.rotation_scope != "collections" { return Ok(()); }
    for id in &preferences.collection_ids {
        let exists: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id=?1)",
            [id], |row| row.get(0),
        ).map_err(|e| format!("Could not check selected collection: {e}"))?;
        if exists == 0 {
            return Err("A selected collection was deleted. Reopen rotation settings and update your selection.".into());
        }
    }
    Ok(())
}

/// Dynamic placeholders are generated locally, never interpolated from names.
/// EXISTS avoids duplicate candidates for a photo in several collections.
/// The filter runs BEFORE the LIMIT, so old saved images are not excluded.
fn rotation_candidate_sql(preferences: &RotationPreferences) -> String {
    let scope = if preferences.rotation_scope == "collections" {
        let placeholders: Vec<String> = (2..2 + preferences.collection_ids.len())
            .map(|number| format!("?{number}")).collect();
        format!(
            "AND EXISTS (SELECT 1 FROM wallpaper_collections wc
             WHERE wc.wallpaper_id=w.id AND wc.collection_id IN ({}))",
            placeholders.join(","),
        )
    } else { String::new() };
    format!(
        "SELECT w.id, w.width, w.height, f.relative_path,
                COALESCE(CAST(strftime('%s', MAX(e.event_time)) AS INTEGER), 0)
         FROM wallpapers w
         JOIN wallpaper_files f ON f.wallpaper_id=w.id AND f.storage_class='managed'
         LEFT JOIN wallpaper_events e ON e.wallpaper_id=w.id AND e.action='apply'
         WHERE (?1=0 OR w.favorite=1)
         {scope}
         GROUP BY w.id, w.width, w.height, f.relative_path
         ORDER BY w.created_at DESC, w.id ASC LIMIT 500"
    )
}

fn includes_reserve(preferences: &RotationPreferences) -> bool {
    preferences.rotation_scope == "all" && !preferences.favorites_only
}

fn candidates(conn: &Connection, paths: &DataPaths,
              preferences: &RotationPreferences) -> Result<Vec<Candidate>, String> {
    let settings = app_settings::read_settings(conn)?;
    let (min_long, min_short) = match settings.minimum_resolution.as_str() {
        "1440p" => (2560, 1440),
        "4K" => (3840, 2160),
        _ => (1920, 1080),
    };
    let sql = rotation_candidate_sql(preferences);
    let mut stmt = conn.prepare(&sql)
        .map_err(|e| format!("Could not inspect Library rotation candidates: {e}"))?;
    let mut bindings = vec![Value::Integer(if preferences.favorites_only { 1 } else { 0 })];
    if preferences.rotation_scope == "collections" {
        bindings.extend(preferences.collection_ids.iter().cloned().map(Value::Text));
    }
    let rows = stmt.query_map(params_from_iter(bindings.iter()), |row| {
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
        // Preserve existing quality and on-disk file checks in every mode.
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
        let library = candidates(conn, paths, &stored.preferences)?.len();
        let reserve = reserve_candidates(conn, paths)?.len();
        let eligible = library + if includes_reserve(&stored.preferences) { reserve } else { 0 };
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
        validate_selected_collections(conn, &preferences)?;
        let before = state.preferences.clone();
        let now = now_unix();
        if !preferences.enabled {
            state.next_due_unix = None;
        } else if !before.enabled ||
            preferences.schedule_mode != before.schedule_mode ||
            preferences.daily_time != before.daily_time ||
            (preferences.schedule_mode == "interval" &&
                preferences.interval_minutes != before.interval_minutes) {
            state.next_due_unix = Some(schedule_next(now, &preferences));
        } else if (!preferences.paused && !preferences.pinned)
            && (before.paused || before.pinned)
            && state.next_due_unix.unwrap_or(now) <= now {
            // Unpin/resume should not immediately trigger missed rotations.
            state.next_due_unix = Some(schedule_next(now, &preferences));
        } else if state.next_due_unix.is_none() {
            state.next_due_unix = Some(schedule_next(now, &preferences));
        }
        if !preferences.enabled || !preferences.discovery_enabled {
            state.next_discovery_unix = None;
        } else if !before.enabled || !before.discovery_enabled
            || before.discovery_topics != preferences.discovery_topics {
            state.next_discovery_unix = Some(now);
            state.discovery_page = 0;
            state.discovery_failures = 0;
            state.last_discovery_error = None;
        }
        state.preferences = preferences;
        if before != state.preferences { state.last_error = None; }
        save(conn, &state)?;
        let library = candidates(conn, paths, &state.preferences)?.len();
        let reserve = reserve_candidates(conn, paths)?.len();
        let eligible = library + if includes_reserve(&state.preferences) { reserve } else { 0 };
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
        state.next_due_unix = Some(schedule_next(now, &state.preferences));
    }
    save(conn, &state)
}

/// One page of each selected topic per round, then advance to the next page.
/// Never send multiple topic requests during a single replenishment attempt.
fn discovery_turn(topics: &[String], cursor: u32) -> (String, u32) {
    let count = topics.len() as u32;
    (topics[(cursor % count) as usize].clone(), (cursor / count) % 20)
}

/// Limit unattended source traffic. Successes and empty searches are routine,
/// not reasons to hammer the provider. Consecutive errors use exponential
/// backoff, and a Retry-After response is a mandatory minimum.
fn discovery_delay(result: &Result<bool, rotation_discovery::DiscoveryFailure>,
    failures: u32) -> i64 {
    match result {
        Ok(true) => 1800,  // one approved wallpaper every 30 minutes at most
        Ok(false) => 3600, // a normal empty search: move to another topic hourly
        Err(failure) => {
            let base = if failure.rate_limited { 3600i64 } else { 1800i64 };
            let shift = failures.saturating_sub(1).min(6);
            let exponential = base.saturating_mul(1i64 << shift).min(86400);
            exponential.max(
                failure.retry_after_seconds.unwrap_or(0).min(172800) as i64
            )
        }
    }
}

// Replenishment and manual Next share RotationGate to avoid concurrent
// duplicate downloads; downloads do NOT hold StorageLock.
fn maybe_replenish(app: &AppHandle, now: i64) -> Result<(), String> {
    let action = with_storage(app, |conn, paths| {
        let state = load(conn)?;
        if !state.preferences.enabled || !state.preferences.discovery_enabled ||
            state.preferences.favorites_only ||
            reserve_candidates(conn, paths)?.len() >= rotation_discovery::RESERVE_TARGET {
            return Ok(None);
        }
        // A manual Next must not bypass a provider's Retry-After deadline.
        if state.next_discovery_unix.is_some_and(|due| due > now) {
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
        state.discovery_failures = if result.is_err() {
            state.discovery_failures.saturating_add(1)
        } else { 0 };
        // Record the wait even when a server error occurs or the app closes.
        state.next_discovery_unix = Some(finished.saturating_add(
            discovery_delay(&result, state.discovery_failures)
        ));
        state.last_discovery_error = match &result {
            Err(failure) => Some(failure.message.clone()),
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
        let library = candidates(conn, paths, &state.preferences)?;
        if let Some(id) = choose_next(&library, &current, now, state.preferences.cooldown_days) {
            return Ok(Some(id));
        }
        if includes_reserve(&state.preferences) {
            let reserve = reserve_candidates(conn, paths)?;
            if let Some(id) = choose_next(&reserve, &current, now, state.preferences.cooldown_days) {
                return Ok(Some(id));
            }
        }
        if state.preferences.rotation_scope == "collections" {
            return Err("No other eligible wallpaper in the selected collections. Add saved landscape wallpapers to those collections or change the rotation selection.".into());
        }
        Err("No other eligible wallpaper. Add a landscape image to Library or enable automatic discovery to replenish your offline reserve.".into())
    })
}

/// Recalculate only *future* daily deadlines after Windows timezone/clock
/// changes. Overdue work is deliberately not moved forward or replayed.
fn reconcile_daily_deadline(app: &AppHandle, now: i64) -> Result<(), String> {
    with_storage(app, |conn, _| {
        let mut state = load(conn)?;
        if let Some(expected) = adjusted_daily_due(
            now, state.next_due_unix, &state.preferences, state.last_error.as_deref()
        ) {
            state.next_due_unix = Some(expected);
            save(conn, &state)?;
        }
        Ok(())
    })
}

/// Native tray quick actions use the same serialized preference updates as
/// the Library controls. No second rotation worker is started by the tray.
pub fn is_enabled(app: &AppHandle) -> Result<bool, String> {
    with_storage(app, |conn, _| Ok(load(conn)?.preferences.enabled))
}
pub fn toggle_pause(app: &AppHandle) -> Result<(), String> {
    let mut settings = get_rotation_status(app.clone())?.preferences;
    if !settings.enabled { return Err("Enable wallpaper rotation before pausing.".into()); }
    settings.paused = !settings.paused;
    save_rotation_preferences(app.clone(), settings).map(|_| ())
}
pub fn toggle_pin(app: &AppHandle) -> Result<(), String> {
    let mut settings = get_rotation_status(app.clone())?.preferences;
    if !settings.enabled { return Err("Enable wallpaper rotation before pinning.".into()); }
    settings.pinned = !settings.pinned;
    save_rotation_preferences(app.clone(), settings).map(|_| ())
}

fn rotate_sync(app: &AppHandle, force: bool) -> Result<Option<ApplyResult>, String> {
    let gate = app.state::<RotationGate>();
    let _gate = gate.0.lock().map_err(|_| "Rotation is busy".to_string())?;
    let now = now_unix();
    if !force { let _ = reconcile_daily_deadline(app, now); }
    // Background polling refills the reserve independently of rotation.
    // A manual Next with no eligible item makes one immediate attempt below,
    // not two redundant Commons requests for the same image.
    if !force { let _ = maybe_replenish(app, now); }
    let mut choice = select_candidate(app, now, force);
    // Next with an empty pool can try discovery immediately instead of
    // asking the user to wait for the next scheduled source refresh.
    if force && choice.is_err() {
        // Do not launch unrelated reserve discovery when the user's pool
        // is restricted to selected collections.
        let may_use_reserve = with_storage(app, |conn, _| {
            Ok(includes_reserve(&load(conn)?.preferences))
        }).unwrap_or(false);
        if may_use_reserve {
            let _ = maybe_replenish(app, now);
            choice = select_candidate(app, now, force);
        }
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

/// One native scheduler per process; after sleep/wake, it handles at most
/// one overdue rotation and advances the saved next due time on success.
/// App startup uses the same persisted schedule rather than replaying missed
/// intervals from every day the machine was offline.
pub fn start(app: AppHandle) {
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
    fn collection_fixture() -> (Connection, DataPaths) {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos();
        let root = std::env::temp_dir().join(
            format!("haven-walls-collection-rotation-{}-{nonce}", std::process::id())
        );
        let paths = DataPaths { root, mode: local_storage::StorageMode::AppData };
        std::fs::create_dir_all(paths.library()).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE app_settings(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
             CREATE TABLE wallpapers(
                id TEXT PRIMARY KEY, width INTEGER, height INTEGER,
                favorite INTEGER, created_at TEXT
             );
             CREATE TABLE wallpaper_files(
                wallpaper_id TEXT, relative_path TEXT, storage_class TEXT
             );
             CREATE TABLE wallpaper_events(
                wallpaper_id TEXT, action TEXT, event_time TEXT
             );
             CREATE TABLE collections(id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE wallpaper_collections(
                wallpaper_id TEXT REFERENCES wallpapers(id),
                collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
                PRIMARY KEY(wallpaper_id, collection_id)
             );
             INSERT INTO collections(id,name) VALUES
                ('warriors','Warriors'), ('nature','Nature');
             INSERT INTO wallpapers(id,width,height,favorite,created_at) VALUES
                ('a',2560,1440,1,'2026-11-19'),
                ('b',2560,1440,0,'2026-11-18'),
                ('c',600,400,1,'2026-11-17');
             INSERT INTO wallpaper_files(wallpaper_id,relative_path,storage_class) VALUES
                ('a','a.jpg','managed'), ('b','b.jpg','managed'),
                ('c','c.jpg','managed');
             INSERT INTO wallpaper_collections(wallpaper_id,collection_id) VALUES
                ('a','warriors'),('a','nature'),('b','warriors'),('c','nature');"
        ).unwrap();
        conn.execute(
            "INSERT INTO app_settings(id,json) VALUES(1,?1)",
            params![serde_json::to_string(&app_settings::AppSettings::default()).unwrap()]
        ).unwrap();
        for id in ["a", "b", "c"] {
            std::fs::write(paths.library().join(format!("{id}.jpg")), b"test-file").unwrap();
        }
        (conn, paths)
    }

    #[test]
    fn collection_rotation_filters_before_limit_and_deduplicates_memberships() {
        let (conn, paths) = collection_fixture();
        let mut prefs = RotationPreferences::default();
        assert_eq!(candidates(&conn, &paths, &prefs).unwrap().len(), 2);
        assert!(includes_reserve(&prefs));
        prefs.rotation_scope = "collections".into();
        prefs.collection_ids = vec!["warriors".into(), "nature".into()];
        assert!(prefs.validate().is_ok());
        validate_selected_collections(&conn, &prefs).unwrap();
        let selected = candidates(&conn, &paths, &prefs).unwrap();
        assert_eq!(selected.len(), 2); // 'a' belongs to both groups, not twice
        assert_eq!(selected.iter().filter(|image| image.id == "a").count(), 1);
        assert!(!includes_reserve(&prefs));
        prefs.collection_ids = vec!["nature".into()];
        let selected = candidates(&conn, &paths, &prefs).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "a"); // excludes low-resolution c
        prefs.favorites_only = true;
        prefs.collection_ids = vec!["warriors".into()];
        let selected = candidates(&conn, &paths, &prefs).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "a");
        prefs.favorites_only = false;
        prefs.collection_ids = vec!["missing".into()];
        assert!(validate_selected_collections(&conn, &prefs).is_err());
        assert!(candidates(&conn, &paths, &prefs).unwrap().is_empty());
        // A deleted collection cannot silently switch to another pool.
        conn.execute("DELETE FROM collections WHERE id='nature'", []).unwrap();
        prefs.collection_ids = vec!["nature".into()];
        assert!(validate_selected_collections(&conn, &prefs).is_err());
        assert!(candidates(&conn, &paths, &prefs).unwrap().is_empty());
        std::fs::remove_dir_all(&paths.root).unwrap();
    }

    #[test]
    fn collection_rotation_defaults_and_validation_are_backwards_compatible() {
        let old: RotationPreferences = serde_json::from_str(
            r#"{"enabled":true,"favoritesOnly":true,"intervalMinutes":60}"#
        ).unwrap();
        assert_eq!(old.rotation_scope, "all");
        assert!(old.collection_ids.is_empty());
        assert!(old.validate().is_ok());
        let mut prefs = old.clone();
        prefs.rotation_scope = "collections".into();
        assert!(prefs.validate().is_err()); // no groups selected
        prefs.collection_ids = vec!["a".into(), "a".into()];
        assert!(prefs.validate().is_err()); // duplicate IDs
        prefs.collection_ids = vec!["warriors".into(), "nature".into()];
        assert!(prefs.validate().is_ok());
        let serialized = serde_json::to_string(&prefs).unwrap();
        let decoded: RotationPreferences = serde_json::from_str(&serialized).unwrap();
        assert_eq!(decoded, prefs);
    }

    #[test]
    fn default_is_opt_in_and_daily() {
        let defaults = RotationPreferences::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.interval_minutes, 1440);
        assert_eq!(defaults.cooldown_days, 30);
        assert_eq!(defaults.schedule_mode, "interval");
        assert_eq!(defaults.daily_time, "09:00");
    }
    #[test]
    fn sleep_wake_keeps_overdue_daily_rotation_due_once() {
        let now = now_unix();
        let mut prefs = RotationPreferences::default();
        prefs.enabled = true;
        prefs.schedule_mode = "daily".into();
        let previous_due = now - 5 * 86400; // machine asleep/off for 5 days
        assert_eq!(adjusted_daily_due(now, Some(previous_due), &prefs, None), None);
        let after_apply = schedule_next(now, &prefs);
        assert!(after_apply > now);
        assert!(after_apply - now <= 90000);
    }
    #[test]
    fn clock_shift_rebases_future_daily_schedule_but_not_failure_retries() {
        let now = now_unix();
        let mut prefs = RotationPreferences::default();
        prefs.enabled = true;
        prefs.schedule_mode = "daily".into();
        let proper = schedule_next(now, &prefs);
        assert_eq!(adjusted_daily_due(now, Some(proper), &prefs, None), None);
        assert_eq!(adjusted_daily_due(now, Some(proper + 3600), &prefs, None), Some(proper));
        assert_eq!(adjusted_daily_due(now, Some(proper + 3600), &prefs, Some("retry")), None);
    }
    #[test]
    fn respects_provider_retry_after_and_exponential_backoff() {
        use rotation_discovery::DiscoveryFailure;
        let limited = Err(DiscoveryFailure {
            message: "HTTP 429".into(),
            retry_after_seconds: Some(7200),
            rate_limited: true,
        });
        assert_eq!(discovery_delay(&limited, 1), 7200);
        assert_eq!(discovery_delay(&limited, 3), 14400);
        assert!(discovery_delay(&limited, 10) >= 86400);
        let network = Err(DiscoveryFailure {
            message: "Network offline".into(),
            retry_after_seconds: None,
            rate_limited: false,
        });
        assert_eq!(discovery_delay(&network, 1), 1800);
        assert_eq!(discovery_delay(&network, 3), 7200);
        assert_eq!(discovery_delay(&Ok(true), 0), 1800);
        assert_eq!(discovery_delay(&Ok(false), 0), 3600);
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
    fn daily_schedule_is_future_and_in_local_time() {
        let mut prefs = RotationPreferences::default();
        prefs.schedule_mode = "daily".into();
        prefs.daily_time = "10:30".into();
        let now = now_unix();
        let next = schedule_next(now, &prefs);
        assert!(next > now);
        assert!(next - now <= 86400 + 7200);
        let local = Local.timestamp_opt(next, 0).single().unwrap();
        assert_eq!((local.hour(), local.minute()), (10,30));
    }
    #[test]
    fn rejects_invalid_daily_times() {
        let mut prefs = RotationPreferences::default();
        prefs.schedule_mode = "daily".into();
        prefs.daily_time = "25:90".into();
        assert!(prefs.validate().is_err());
        prefs.daily_time = "07:45".into();
        assert!(prefs.validate().is_ok());
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
