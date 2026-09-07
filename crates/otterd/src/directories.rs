use crate::ApiResult;
use axum::{extract::Query, Json};
use otter_core::git;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;

#[derive(Default, Deserialize)]
pub struct Browse {
    path: Option<String>,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    offset: usize,
}

// Mounted under the authenticated API, never expose this as a static file server.
pub async fn browse(Query(input): Query<Browse>) -> ApiResult {
    let cwd = std::env::current_dir()?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or(cwd.clone());
    let requested = input
        .path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(home.clone());
    let path = tokio::fs::canonicalize(requested)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot open directory: {e}"))?;
    let mut reader = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot read directory: {e}"))?;
    let mut entries = Vec::new();
    let mut inspected = 0;
    let mut truncated = false;
    while let Some(entry) = reader.next_entry().await? {
        inspected += 1;
        if inspected > 10000 {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !input.hidden && name.starts_with('.') {
            continue;
        }
        if !tokio::fs::metadata(entry.path())
            .await
            .is_ok_and(|m| m.is_dir())
        {
            continue;
        }
        let is_git = tokio::fs::try_exists(entry.path().join(".git"))
            .await
            .unwrap_or(false);
        entries.push(json!({"name":name,"path":entry.path(),"is_git":is_git}));
    }
    entries.sort_by_key(|e| e["name"].as_str().unwrap_or_default().to_lowercase());
    let total = entries.len();
    let entries: Vec<_> = entries.into_iter().skip(input.offset).take(200).collect();
    let git_root = git::root(&path).await.ok();
    Ok(Json(
        json!({"path":path,"parent":path.parent(),"home":home,"cwd":cwd,"git_root":git_root,"entries":entries,"total":total,"truncated":truncated}),
    ))
}
