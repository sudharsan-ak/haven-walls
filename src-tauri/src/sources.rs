//! Browsing-only integrations. Each external image retains its provider and rights notice.
//! A photo being shown here does not authorize caching or applying it as wallpaper.
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const USER_AGENT: &str =
    "HavenWalls/0.1 (https://github.com/sudharsan-ak/haven-walls; contact: GitHub issues)";
const BING_API: &str = "https://www.bing.com/HPImageArchive.aspx";
const EARTH_CATALOG: &str =
    "https://raw.githubusercontent.com/limhenry/earthview/master/earthview.json";
const SPORTS_API: &str = "https://www.thesportsdb.com/api/v1/json/123/searchteams.php";
const TMDB_API: &str = "https://api.themoviedb.org/3";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImage {
    pub id: String,
    pub source: String,
    pub title: String,
    pub preview_url: String,
    pub original_url: Option<String>,
    pub page_url: String,
    pub credit: String,
    pub rights: String,
    pub width: u32,
    pub height: u32,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub items: Vec<CatalogImage>,
    pub note: String,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Could not initialize the network connection".to_string())
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("This provider is rate-limiting requests. Try again later.".into());
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Your API credentials were rejected. Check the token.".into());
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("The image provider returned HTTP {}", e.status().map_or(0, |s| s.as_u16())))?;
    if response.content_length().is_some_and(|size| size > 2_000_000) {
        return Err("Image catalog response is too large".into());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "Could not read the provider response".to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("Image catalog response is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Unexpected image catalog response".to_string())
}

fn value<'a>(item: &'a Value, field: &str) -> &'a str {
    item.get(field).and_then(Value::as_str).unwrap_or("")
}

fn is_bing_image_path(path: &str) -> bool {
    path.starts_with("/th?id=OHR.") && !path.contains("://")
}

fn bing_from_json(data: &Value) -> CatalogResponse {
    let mut items = Vec::new();
    if let Some(images) = data.get("images").and_then(Value::as_array) {
        for image in images.iter().take(8) {
            let base = value(image, "urlbase");
            if !is_bing_image_path(base) {
                continue;
            }
            let title = value(image, "title");
            let credit = value(image, "copyright");
            let date = value(image, "startdate");
            let page = value(image, "copyrightlink");
            let page_url = if page.starts_with("https://www.bing.com/") {
                page.to_string()
            } else {
                "https://www.bing.com/".to_string()
            };
            items.push(CatalogImage {
                id: format!("bing-{date}"),
                source: "Bing Daily".into(),
                title: if title.is_empty() { credit.into() } else { title.into() },
                preview_url: format!("https://www.bing.com{base}_1920x1080.jpg"),
                original_url: None,
                page_url,
                credit: credit.into(),
                rights: "Bing image rights not independently verified; preview only".into(),
                width: 1920,
                height: 1080,
                kind: "image".into(),
            });
        }
    }
    CatalogResponse {
        items,
        note: "Recent Bing homepage photos. This is a daily feed, not a keyword search. Bing's feed is undocumented and can change.".into(),
    }
}

async fn bing_feed(client: &Client) -> Result<CatalogResponse, String> {
    let response = client
        .get(BING_API)
        .query(&[("format", "js"), ("idx", "0"), ("n", "8"), ("mkt", "en-US")])
        .send()
        .await
        .map_err(|_| "Could not reach Bing's daily image feed".to_string())?;
    Ok(bing_from_json(&read_json(response).await?))
}

fn earth_from_json(data: &Value, query: &str) -> CatalogResponse {
    let query = query.trim().to_lowercase();
    let mut entries = Vec::new();
    if let Some(images) = data.as_array() {
        for image in images {
            let url = value(image, "image");
            if !url.starts_with("https://www.gstatic.com/prettyearth/assets/full/") {
                continue;
            }
            let region = value(image, "region");
            let country = value(image, "country");
            let title = [region, country]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            if !query.is_empty() && !title.to_lowercase().contains(&query) {
                continue;
            }
            let map = value(image, "map");
            let page_url = if map.starts_with("https://www.google.com/maps/") {
                map.to_string()
            } else {
                "https://earth.google.com/".to_string()
            };
            entries.push(CatalogImage {
                id: format!("earth-{}", url.rsplit('/').next().unwrap_or("image")),
                source: "Google Earth View".into(),
                title: if title.is_empty() { "Earth View".into() } else { title },
                preview_url: url.into(),
                original_url: None,
                page_url,
                credit: "Google Earth imagery".into(),
                rights: "Google imagery rights not verified for third-party wallpaper use; preview only".into(),
                width: 0,
                height: 0,
                kind: "image".into(),
            });
        }
    }
    // Sample across the archive instead of returning 24 nearly identical neighboring photos.
    let count = entries.len();
    let take = count.min(24);
    let items = (0..take)
        .map(|index| entries[index * count / take].clone())
        .collect();
    CatalogResponse {
        items,
        note: "Archived Earth View image index, provided by a community mirror. Availability and usage rights are not guaranteed.".into(),
    }
}

async fn earth_feed(client: &Client, query: &str) -> Result<CatalogResponse, String> {
    let response = client
        .get(EARTH_CATALOG)
        .send()
        .await
        .map_err(|_| "Could not reach the Earth View catalog mirror".to_string())?;
    Ok(earth_from_json(&read_json(response).await?, query))
}

fn sports_from_json(data: &Value) -> CatalogResponse {
    let mut items = Vec::new();
    if let Some(teams) = data.get("teams").and_then(Value::as_array) {
        for team in teams.iter().take(15) {
            let id = value(team, "idTeam");
            if id.is_empty() {
                continue;
            }
            let preview = [
                "strFanart1",
                "strFanart2",
                "strTeamBanner",
                "strTeamBadge",
            ]
            .into_iter()
            .map(|key| value(team, key))
            .find(|url| url.starts_with("https://") && url.contains("thesportsdb.com"))
            .unwrap_or("");
            if preview.is_empty() {
                continue;
            }
            items.push(CatalogImage {
                id: format!("sports-{id}"),
                source: "TheSportsDB".into(),
                title: value(team, "strTeam").into(),
                preview_url: preview.into(),
                original_url: None,
                page_url: format!("https://www.thesportsdb.com/team/{id}"),
                credit: format!(
                    "{} · {}",
                    value(team, "strLeague"),
                    value(team, "strCountry")
                ),
                rights: "Team artwork may contain third-party trademarks and photos; not cleared for wallpaper use".into(),
                width: 0,
                height: 0,
                kind: "image".into(),
            });
        }
    }
    CatalogResponse {
        items,
        note: "Team artwork and badges from TheSportsDB. These previews are not guaranteed to be 1080p or licensed for wallpaper use.".into(),
    }
}

async fn sports_search(client: &Client, query: &str) -> Result<CatalogResponse, String> {
    if query.trim().chars().count() < 2 {
        return Err("Enter a team name, such as Golden State Warriors or Mumbai Indians.".into());
    }
    let response = client
        .get(SPORTS_API)
        .query(&[("t", query.trim())])
        .send()
        .await
        .map_err(|_| "Could not reach TheSportsDB".to_string())?;
    Ok(sports_from_json(&read_json(response).await?))
}

fn tmdb_image_url(path: &str, size: &str) -> Option<String> {
    if !path.starts_with('/') || path.contains("..") || !path.ends_with(".jpg") && !path.ends_with(".png") {
        return None;
    }
    Some(format!("https://image.tmdb.org/t/p/{size}{path}"))
}

fn tmdb_shows_from_json(data: &Value) -> CatalogResponse {
    let mut items = Vec::new();
    if let Some(shows) = data.get("results").and_then(Value::as_array) {
        for show in shows.iter().take(12) {
            let Some(id) = show.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(poster_url) = tmdb_image_url(value(show, "poster_path"), "w342") else {
                continue;
            };
            items.push(CatalogImage {
                id: id.to_string(),
                source: "TMDB".into(),
                title: value(show, "name").into(),
                preview_url: poster_url,
                original_url: None,
                page_url: format!("https://www.themoviedb.org/tv/{id}"),
                credit: format!("TV series · {}", value(show, "first_air_date")),
                rights: "Select the correct series to view backdrops; artwork rights require verification".into(),
                width: 0,
                height: 0,
                kind: "tv-show".into(),
            });
        }
    }
    CatalogResponse {
        items,
        note: "Select the exact TV show before browsing its backdrops. TMDB attribution and image rights apply.".into(),
    }
}

fn tmdb_backdrops_from_json(id: u64, data: &Value) -> CatalogResponse {
    let mut items = Vec::new();
    if let Some(backdrops) = data.get("backdrops").and_then(Value::as_array) {
        for (index, backdrop) in backdrops.iter().enumerate() {
            let width = backdrop.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
            let height = backdrop.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
            if width < 1920 || height < 1080 || width <= height {
                continue;
            }
            let Some(preview_url) = tmdb_image_url(value(backdrop, "file_path"), "w780") else {
                continue;
            };
            let original_url = tmdb_image_url(value(backdrop, "file_path"), "original");
            items.push(CatalogImage {
                id: format!("tmdb-{id}-{index}"),
                source: "TMDB".into(),
                title: format!("TV backdrop {}", index + 1),
                preview_url,
                original_url,
                page_url: format!("https://www.themoviedb.org/tv/{id}"),
                credit: "Backdrop via TMDB".into(),
                rights: "Third-party TV artwork; usage rights require verification".into(),
                width,
                height,
                kind: "image".into(),
            });
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(u64::from(item.width) * u64::from(item.height)));
    items.truncate(24);
    CatalogResponse {
        items,
        note: "TMDB show backdrops. Image metadata is provided for preview only, not cleared for wallpaper use.".into(),
    }
}

async fn tmdb_search(
    client: &Client,
    query: &str,
    token: &str,
) -> Result<CatalogResponse, String> {
    if query.trim().chars().count() < 2 {
        return Err("Enter a TV show title.".into());
    }
    let response = client
        .get(format!("{TMDB_API}/search/tv"))
        .bearer_auth(token)
        .query(&[("query", query.trim()), ("include_adult", "false"), ("language", "en-US")])
        .send()
        .await
        .map_err(|_| "Could not reach TMDB".to_string())?;
    Ok(tmdb_shows_from_json(&read_json(response).await?))
}

async fn tmdb_backdrops(client: &Client, id: u64, token: &str) -> Result<CatalogResponse, String> {
    let response = client
        .get(format!("{TMDB_API}/tv/{id}/images"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Could not reach TMDB backdrop search".to_string())?;
    Ok(tmdb_backdrops_from_json(id, &read_json(response).await?))
}

#[tauri::command]
pub async fn browse_wallpaper_source(
    source: String,
    query: String,
    tmdb_token: Option<String>,
) -> Result<CatalogResponse, String> {
    if query.chars().count() > 100 {
        return Err("Search is too long".into());
    }
    let client = client()?;
    match source.as_str() {
        "bing" => bing_feed(&client).await,
        "earth" => earth_feed(&client, &query).await,
        "sports" => sports_search(&client, &query).await,
        "tmdb" => {
            let token = tmdb_token.as_deref().unwrap_or("").trim();
            if token.is_empty() {
                return Err("A TMDB API Read Access Token is required for TV show search.".into());
            }
            tmdb_search(&client, &query, token).await
        }
        _ => Err("This image source is not available".into()),
    }
}

#[tauri::command]
pub async fn browse_tmdb_backdrops(
    tv_id: u64,
    tmdb_token: String,
) -> Result<CatalogResponse, String> {
    let token = tmdb_token.trim();
    if token.is_empty() {
        return Err("A TMDB API Read Access Token is required.".into());
    }
    tmdb_backdrops(&client()?, tv_id, token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bing_daily_feed_maps_to_previews() {
        let json = serde_json::json!({"images":[{
            "urlbase":"/th?id=OHR.Test_EN-US123",
            "copyright":"Photo credit",
            "title":"Mountains",
            "startdate":"20261113"
        }]});
        let result = bing_from_json(&json);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].width, 1920);
        assert_eq!(result.items[0].title, "Mountains");
    }

    #[test]
    fn earth_catalog_can_filter_country() {
        let json = serde_json::json!([
            {"image":"https://www.gstatic.com/prettyearth/assets/full/10.jpg",
             "region":"Swiss Alps","country":"Switzerland",
             "map":"https://www.google.com/maps/example"},
            {"image":"https://www.gstatic.com/prettyearth/assets/full/11.jpg",
             "region":"Utah","country":"United States"}
        ]);
        let result = earth_from_json(&json, "Switzerland");
        assert_eq!(result.items.len(), 1);
        assert!(result.items[0].title.contains("Swiss Alps"));
    }

    #[test]
    fn tmdb_url_rejects_relative_traversal() {
        assert!(tmdb_image_url("/abc.jpg", "w780").is_some());
        assert!(tmdb_image_url("../malicious.jpg", "w780").is_none());
    }

    #[test]
    fn sports_search_maps_team_art() {
        let json = serde_json::json!({"teams":[{
            "idTeam":"123","strTeam":"Golden State Warriors",
            "strLeague":"NBA","strCountry":"United States",
            "strTeamBadge":"https://www.thesportsdb.com/images/teams/123.png"
        }]});
        let result = sports_from_json(&json);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Golden State Warriors");
    }
}
