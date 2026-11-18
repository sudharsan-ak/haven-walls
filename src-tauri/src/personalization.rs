//! Local-only personalization storage. Categories are an existing PR #3 schema;
//! collections and followed interests are additive and never duplicate images.
use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{app_settings, local_storage::{self, StorageLock}};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedGroup {
    id: String,
    name: String,
    parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupAssignment {
    wallpaper_id: String,
    group_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowedInterest {
    id: String,
    kind: String,
    provider: String,
    provider_id: String,
    title: String,
    parent_id: Option<String>,
    preferences: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterestInput {
    kind: String,
    provider: String,
    provider_id: String,
    title: String,
    parent_id: Option<String>,
    preferences: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalizationSnapshot {
    categories: Vec<NamedGroup>,
    collections: Vec<NamedGroup>,
    followed_interests: Vec<FollowedInterest>,
    wallpaper_categories: Vec<GroupAssignment>,
    wallpaper_collections: Vec<GroupAssignment>,
}

/// Upgrade v1 in place. Reopening an existing v2 database is idempotent.
/// Existing Gallery localStorage profiles and browsing history are untouched.
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS collections (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE UNIQUE INDEX IF NOT EXISTS ix_collections_name
             ON collections(name COLLATE NOCASE);
         CREATE TABLE IF NOT EXISTS wallpaper_collections (
             wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE CASCADE,
             collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
             PRIMARY KEY(wallpaper_id, collection_id)
         );
         CREATE INDEX IF NOT EXISTS ix_wallpaper_collections_group
             ON wallpaper_collections(collection_id);
         CREATE TABLE IF NOT EXISTS followed_interests (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL CHECK(kind IN ('league','team','player','tv','movie','place')),
             provider TEXT NOT NULL,
             provider_id TEXT NOT NULL,
             title TEXT NOT NULL,
             parent_id TEXT,
             preferences_json TEXT NOT NULL DEFAULT '{}',
             created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             UNIQUE(kind, provider, provider_id)
         );
         COMMIT;"
    ).map_err(|e| format!("Could not upgrade personalization storage: {e}"))?;
    let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Could not inspect personalization schema: {e}"))?;
    if version < 3 {
        // The original PR #10 table only allowed sports and TV. Rebuild its
        // local interest metadata to support movie and place interests too.
        // This does not touch Library images, browser state, or collections.
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE followed_interests_v3 (
                 id TEXT PRIMARY KEY,
                 kind TEXT NOT NULL CHECK(kind IN ('league','team','player','tv','movie','place')),
                 provider TEXT NOT NULL,
                 provider_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 parent_id TEXT,
                 preferences_json TEXT NOT NULL DEFAULT '{}',
                 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 UNIQUE(kind, provider, provider_id)
             );
             INSERT INTO followed_interests_v3
                 (id,kind,provider,provider_id,title,parent_id,preferences_json,created_at)
               SELECT id,kind,provider,provider_id,title,parent_id,preferences_json,created_at
               FROM followed_interests;
             DROP TABLE followed_interests;
             ALTER TABLE followed_interests_v3 RENAME TO followed_interests;
             PRAGMA user_version=3;
             COMMIT;"
        ).map_err(|e| format!("Could not upgrade interest kinds: {e}"))?;
    }
    Ok(())
}

fn with_db<T>(
    app: &AppHandle, state: &State<'_, StorageLock>,
    work: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = state.0.lock()
        .map_err(|_| "Wallpaper storage is busy.".to_string())?;
    let paths = local_storage::current_paths(app)?;
    let mut conn = app_settings::open_database(&paths)?;
    work(&mut conn)
}

fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 60 ||
        name.chars().any(char::is_control) {
        return Err("Use a name between 1 and 60 characters.".into());
    }
    Ok(name)
}

fn group_table(kind: &str) -> Result<&'static str, String> {
    match kind {
        "category" => Ok("categories"),
        "collection" => Ok("collections"),
        _ => Err("Choose a category or collection.".into()),
    }
}

fn new_id(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
        .map_err(|e| format!("Could not create a local identifier: {e}"))
}

fn load_groups(conn: &Connection, table: &str) -> Result<Vec<NamedGroup>, String> {
    // The table name comes only from group_table(), never from user SQL.
    let parent = if table == "categories" { "parent_id" } else { "NULL" };
    let sql = format!("SELECT id, name, {parent} FROM {table} ORDER BY name COLLATE NOCASE, id");
    let mut statement = conn.prepare(&sql)
        .map_err(|e| format!("Could not list {table}: {e}"))?;
    let rows = statement.query_map([], |row| Ok(NamedGroup {
        id: row.get(0)?, name: row.get(1)?, parent_id: row.get(2)?,
    })).map_err(|e| format!("Could not read {table}: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Could not read {table}: {e}"))
}

fn load_assignments(conn: &Connection, table: &str, field: &str)
    -> Result<Vec<GroupAssignment>, String> {
    let sql = format!("SELECT wallpaper_id, {field} FROM {table} ORDER BY wallpaper_id, {field}");
    let mut statement = conn.prepare(&sql)
        .map_err(|e| format!("Could not read wallpaper associations: {e}"))?;
    let rows = statement.query_map([], |row| Ok(GroupAssignment {
        wallpaper_id: row.get(0)?, group_id: row.get(1)?,
    })).map_err(|e| format!("Could not read wallpaper associations: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Could not read wallpaper associations: {e}"))
}

fn snapshot(conn: &Connection) -> Result<PersonalizationSnapshot, String> {
    let mut statement = conn.prepare(
        "SELECT id, kind, provider, provider_id, title, parent_id, preferences_json
         FROM followed_interests ORDER BY kind, title COLLATE NOCASE"
    ).map_err(|e| format!("Could not read followed interests: {e}"))?;
    let rows = statement.query_map([], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
        row.get::<_, String>(2)?, row.get::<_, String>(3)?,
        row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?,
        row.get::<_, String>(6)?,
    ))).map_err(|e| format!("Could not read followed interests: {e}"))?;
    let mut followed_interests = Vec::new();
    for row in rows {
        let (id, kind, provider, provider_id, title, parent_id, json) =
            row.map_err(|e| format!("Could not read followed interests: {e}"))?;
        let preferences = serde_json::from_str(&json)
            .map_err(|e| format!("Saved interest preferences are invalid: {e}"))?;
        followed_interests.push(FollowedInterest {
            id, kind, provider, provider_id, title, parent_id, preferences,
        });
    }
    Ok(PersonalizationSnapshot {
        categories: load_groups(conn, "categories")?,
        collections: load_groups(conn, "collections")?,
        followed_interests,
        wallpaper_categories: load_assignments(
            conn, "wallpaper_categories", "category_id")?,
        wallpaper_collections: load_assignments(
            conn, "wallpaper_collections", "collection_id")?,
    })
}

#[tauri::command]
pub fn get_personalization(
    app: AppHandle, state: State<'_, StorageLock>,
) -> Result<PersonalizationSnapshot, String> {
    with_db(&app, &state, |conn| snapshot(conn))
}

fn check_unique_name(conn: &Connection, table: &str, name: &str, except: &str)
    -> Result<(), String> {
    let sql = format!("SELECT id FROM {table} WHERE name=?1 COLLATE NOCASE AND id<>?2 LIMIT 1");
    let found: Option<String> = conn.query_row(&sql, params![name, except],
        |row| row.get(0)).optional()
        .map_err(|e| format!("Could not validate {table} name: {e}"))?;
    if found.is_some() { return Err("A group with that name already exists.".into()); }
    Ok(())
}

#[tauri::command]
pub fn create_personalization_group(
    app: AppHandle, state: State<'_, StorageLock>, kind: String, name: String,
) -> Result<NamedGroup, String> {
    let table = group_table(&kind)?;
    let name = clean_name(&name)?;
    with_db(&app, &state, |conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        check_unique_name(&tx, table, &name, "")?;
        let id = new_id(&tx)?;
        tx.execute(&format!("INSERT INTO {table}(id, name) VALUES(?1, ?2)"),
            params![id, name])
            .map_err(|e| format!("Could not create {kind}: {e}"))?;
        tx.commit().map_err(|e| format!("Could not save {kind}: {e}"))?;
        Ok(NamedGroup { id, name, parent_id: None })
    })
}

#[tauri::command]
pub fn rename_personalization_group(
    app: AppHandle, state: State<'_, StorageLock>,
    kind: String, id: String, name: String,
) -> Result<(), String> {
    let table = group_table(&kind)?;
    let name = clean_name(&name)?;
    with_db(&app, &state, |conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        check_unique_name(&tx, table, &name, &id)?;
        let updated = tx.execute(&format!("UPDATE {table} SET name=?1 WHERE id=?2"),
            params![name, id])
            .map_err(|e| format!("Could not rename {kind}: {e}"))?;
        if updated == 0 { return Err(format!("This {kind} no longer exists.")); }
        tx.commit().map_err(|e| format!("Could not save {kind}: {e}"))
    })
}

#[tauri::command]
pub fn delete_personalization_group(
    app: AppHandle, state: State<'_, StorageLock>, kind: String, id: String,
) -> Result<(), String> {
    let table = group_table(&kind)?;
    with_db(&app, &state, |conn| {
        let deleted = conn.execute(&format!("DELETE FROM {table} WHERE id=?1"), [id])
            .map_err(|e| format!("Could not delete {kind}: {e}"))?;
        if deleted == 0 { return Err(format!("This {kind} no longer exists.")); }
        Ok(())
    })
}

fn validate_group_ids(conn: &Connection, table: &str, ids: &[String])
    -> Result<BTreeSet<String>, String> {
    if ids.len() > 100 { return Err("Too many groups selected.".into()); }
    let mut unique = BTreeSet::new();
    for id in ids {
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid group identifier.".into());
        }
        if !unique.insert(id.clone()) { continue; }
        let exists: i64 = conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
            [id], |row| row.get(0)
        ).map_err(|e| format!("Could not check group membership: {e}"))?;
        if exists == 0 { return Err("A selected group was removed. Refresh and retry.".into()); }
    }
    Ok(unique)
}

#[tauri::command]
pub fn save_wallpaper_organization(
    app: AppHandle, state: State<'_, StorageLock>, wallpaper_id: String,
    category_ids: Vec<String>, collection_ids: Vec<String>,
) -> Result<(), String> {
    with_db(&app, &state, |conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let managed: i64 = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM wallpapers w
             JOIN wallpaper_files f ON f.wallpaper_id=w.id AND f.storage_class='managed'
             WHERE w.id=?1)", [&wallpaper_id], |row| row.get(0)
        ).map_err(|e| format!("Could not verify Library image: {e}"))?;
        if managed == 0 { return Err("This image is no longer in the managed Library.".into()); }
        let categories = validate_group_ids(&tx, "categories", &category_ids)?;
        let collections = validate_group_ids(&tx, "collections", &collection_ids)?;
        tx.execute("DELETE FROM wallpaper_categories WHERE wallpaper_id=?1", [&wallpaper_id])
            .map_err(|e| format!("Could not update image categories: {e}"))?;
        tx.execute("DELETE FROM wallpaper_collections WHERE wallpaper_id=?1", [&wallpaper_id])
            .map_err(|e| format!("Could not update image collections: {e}"))?;
        for id in categories {
            tx.execute(
                "INSERT INTO wallpaper_categories(wallpaper_id,category_id) VALUES(?1,?2)",
                params![wallpaper_id, id]
            ).map_err(|e| format!("Could not link image category: {e}"))?;
        }
        for id in collections {
            tx.execute(
                "INSERT INTO wallpaper_collections(wallpaper_id,collection_id) VALUES(?1,?2)",
                params![wallpaper_id, id]
            ).map_err(|e| format!("Could not link image collection: {e}"))?;
        }
        tx.commit().map_err(|e| format!("Could not save image organization: {e}"))
    })
}

fn validate_interest(input: &InterestInput) -> Result<String, String> {
    if !["league", "team", "player", "tv", "movie", "place"].contains(&input.kind.as_str()) {
        return Err("Unsupported interest type.".into());
    }
    if !["sportsdb", "tmdb", "custom"].contains(&input.provider.as_str()) {
        return Err("Unsupported interest provider.".into());
    }
    if ["tv","movie"].contains(&input.kind.as_str()) &&
        !["tmdb", "custom"].contains(&input.provider.as_str()) {
        return Err("TV and movie interests require TMDB or a custom search.".into());
    }
    for id in [&input.provider_id, input.parent_id.as_ref().unwrap_or(&input.provider_id)] {
        if id.is_empty() || id.len() > 120 ||
            !id.chars().all(|ch| ch.is_ascii_alphanumeric() ||
                matches!(ch, '-' | '_' | ':' | '.')) {
            return Err("Invalid provider identifier.".into());
        }
    }
    if !input.preferences.is_object() ||
        input.preferences.to_string().len() > 4096 {
        return Err("Interest settings must be a small JSON object.".into());
    }
    clean_name(&input.title)
}

#[tauri::command]
pub fn save_followed_interest(
    app: AppHandle, state: State<'_, StorageLock>, input: InterestInput,
) -> Result<(), String> {
    let title = validate_interest(&input)?;
    with_db(&app, &state, |conn| {
        let id = new_id(conn)?;
        let json = input.preferences.to_string();
        conn.execute(
            "INSERT INTO followed_interests
             (id,kind,provider,provider_id,title,parent_id,preferences_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(kind,provider,provider_id) DO UPDATE SET
             title=excluded.title,parent_id=excluded.parent_id,
             preferences_json=excluded.preferences_json",
            params![id, input.kind, input.provider, input.provider_id,
                title, input.parent_id, json]
        ).map_err(|e| format!("Could not save followed interest: {e}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn remove_followed_interest(
    app: AppHandle, state: State<'_, StorageLock>, id: String,
) -> Result<(), String> {
    with_db(&app, &state, |conn| {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // Flexible follows: removing a league/team never removes its followed
        // children; they simply become independent interests.
        tx.execute("UPDATE followed_interests SET parent_id=NULL WHERE parent_id=?1", [&id])
            .map_err(|e| format!("Could not preserve child interests: {e}"))?;
        tx.execute("DELETE FROM followed_interests WHERE id=?1", [&id])
            .map_err(|e| format!("Could not remove followed interest: {e}"))?;
        tx.commit().map_err(|e| format!("Could not save interest removal: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_keeps_existing_categories_and_is_repeatable() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE wallpapers(id TEXT PRIMARY KEY);
             CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 parent_id TEXT REFERENCES categories(id));
             CREATE TABLE wallpaper_categories(
                 wallpaper_id TEXT REFERENCES wallpapers(id) ON DELETE CASCADE,
                 category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
                 PRIMARY KEY(wallpaper_id,category_id));
             INSERT INTO categories(id,name) VALUES('legacy','Saved Category');
             PRAGMA user_version=1;"
        ).unwrap();
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        assert_eq!(load_groups(&conn, "categories").unwrap()[0].name, "Saved Category");
    }

    #[test]
    fn collections_cascade_memberships_not_wallpapers() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE wallpapers(id TEXT PRIMARY KEY);
             CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL,
                 parent_id TEXT REFERENCES categories(id));
             CREATE TABLE wallpaper_categories(
                 wallpaper_id TEXT REFERENCES wallpapers(id) ON DELETE CASCADE,
                 category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
                 PRIMARY KEY(wallpaper_id,category_id));
             INSERT INTO wallpapers(id) VALUES('image');"
        ).unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute("INSERT INTO collections(id,name) VALUES('group','Favorites 2026')", []).unwrap();
        conn.execute("INSERT INTO wallpaper_collections(wallpaper_id,collection_id) VALUES('image','group')", []).unwrap();
        conn.execute("DELETE FROM collections WHERE id='group'", []).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM wallpaper_collections", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM wallpapers", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn upgrades_old_interest_records_without_losing_preferences() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE wallpapers(id TEXT PRIMARY KEY);
             CREATE TABLE categories(id TEXT PRIMARY KEY,name TEXT NOT NULL,
                 parent_id TEXT REFERENCES categories(id));
             CREATE TABLE wallpaper_categories(
                 wallpaper_id TEXT REFERENCES wallpapers(id) ON DELETE CASCADE,
                 category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
                 PRIMARY KEY(wallpaper_id,category_id));
             CREATE TABLE followed_interests (
                 id TEXT PRIMARY KEY,
                 kind TEXT NOT NULL CHECK(kind IN ('league','team','player','tv')),
                 provider TEXT NOT NULL,
                 provider_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 parent_id TEXT,
                 preferences_json TEXT NOT NULL DEFAULT '{}',
                 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                 UNIQUE(kind, provider, provider_id)
             );
             INSERT INTO followed_interests
                 (id,kind,provider,provider_id,title,preferences_json)
                 VALUES('oldteam','team','sportsdb','123','Warriors',
                 '{\"keyword\":\"Golden State Warriors\",\"timeRange\":\"day\"}');
             PRAGMA user_version=2;"
        ).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r|
            r.get::<_, i64>(0)).unwrap(), 3);
        let existing: (String, String) = conn.query_row(
            "SELECT title, preferences_json FROM followed_interests WHERE id='oldteam'",
            [], |row| Ok((row.get(0)?, row.get(1)?))
        ).unwrap();
        assert_eq!(existing.0, "Warriors");
        assert!(existing.1.contains("Golden State Warriors"));
        conn.execute(
            "INSERT INTO followed_interests
               (id,kind,provider,provider_id,title) VALUES('movie','movie','custom','new','Movie')",
            []
        ).unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM followed_interests",
            [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn invalid_names_and_interests_are_rejected() {
        assert!(clean_name("   ").is_err());
        assert!(clean_name("abc\nxyz").is_ok());
        let input = InterestInput {
            kind: "tv".into(), provider: "tmdb".into(),
            provider_id: "42".into(), title: "Some Show".into(),
            parent_id: None, preferences: serde_json::json!({}),
        };
        assert!(validate_interest(&input).is_ok());
        assert!(validate_interest(&InterestInput {
            provider_id: "bad/id".into(), ..input
        }).is_err());
    }
}
