use crate::{ApiResult, AppState};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use otter_core::{ingestion, providers};
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn providers_list() -> ApiResult {
    let (codex, claude) = tokio::join!(providers::detect("codex"), providers::detect("claude"));
    Ok(Json(json!([
        codex,
        claude,
        providers::detect("fake").await
    ])))
}

#[derive(Default, Deserialize)]
pub struct Page {
    pub offset: Option<u32>,
    pub limit: Option<u32>,
    pub kind: Option<String>,
    pub q: Option<String>,
    pub focus: Option<i64>,
}
impl Page {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(100).clamp(1, 200) as i64
    }
    fn offset(&self) -> i64 {
        self.offset.unwrap_or(0) as i64
    }
}

pub async fn sessions(State(s): State<AppState>, Query(p): Query<Page>) -> ApiResult {
    let rows=s.db.rows("SELECT s.*,(SELECT count(*) FROM normalized_events e WHERE e.session_id=s.id) AS event_count FROM provider_sessions s ORDER BY last_seen_at DESC LIMIT ? OFFSET ?",vec![p.limit().into(),p.offset().into()]).await?;
    let total =
        s.db.one("SELECT count(*) AS n FROM provider_sessions", vec![])
            .await?;
    Ok(Json(json!({"items":rows,"total":total["n"]})))
}

pub async fn session(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let row =
        s.db.one(
            "SELECT * FROM provider_sessions WHERE id=?",
            vec![id.clone().into()],
        )
        .await?;
    let counts =
        s.db.rows(
            "SELECT kind,count(*) AS count FROM normalized_events WHERE session_id=? GROUP BY kind",
            vec![id.clone().into()],
        )
        .await?;
    let loops=s.db.rows("SELECT text,count(*) AS count FROM normalized_events WHERE session_id=? AND kind='tool.shell' GROUP BY text HAVING count(*)>=5",vec![id.into()]).await?;
    Ok(Json(
        json!({"session":row,"counts":counts,"repeated_commands":loops}),
    ))
}

pub async fn events(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(p): Query<Page>,
) -> ApiResult {
    let (table, filter) = match p.kind.as_deref().unwrap_or("timeline") {
        "raw" => ("raw_events", ""),
        "conversation" => (
            "normalized_events",
            " AND kind IN ('user.message','assistant.message','assistant.reasoning_summary')",
        ),
        "actions" => (
            "normalized_events",
            " AND (kind LIKE 'tool.%' OR kind LIKE 'git.%')",
        ),
        "files" => (
            "normalized_events",
            " AND kind IN ('tool.file_read','tool.file_write')",
        ),
        "commands" => (
            "normalized_events",
            " AND kind IN ('tool.shell','tool.result')",
        ),
        _ => ("normalized_events", ""),
    };
    let offset = if let Some(focus) = p.focus {
        s.db.one(
            &format!("SELECT count(*) AS n FROM {table} WHERE session_id=?{filter} AND id<?"),
            vec![id.clone().into(), focus.into()],
        )
        .await?["n"]
            .as_i64()
            .unwrap_or(0)
    } else {
        p.offset()
    };
    let rows =
        s.db.rows(
            &format!(
                "SELECT * FROM {table} WHERE session_id=?{filter} ORDER BY id LIMIT ? OFFSET ?"
            ),
            vec![id.clone().into(), p.limit().into(), offset.into()],
        )
        .await?;
    let total =
        s.db.one(
            &format!("SELECT count(*) AS n FROM {table} WHERE session_id=?{filter}"),
            vec![id.into()],
        )
        .await?;
    Ok(Json(json!({"items":rows,"total":total["n"]})))
}

pub async fn search(State(s): State<AppState>, Query(p): Query<Page>) -> ApiResult {
    let q = p.q.clone().unwrap_or_default();
    let query = q
        .split_whitespace()
        .take(20)
        .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    if query.is_empty() {
        return Ok(Json(json!({"items":[],"total":0})));
    }
    let rows=s.db.rows("SELECT kind,source_id,session_id,work_unit_id,snippet(search_index,4,'[',']',' … ',32) AS snippet FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ? OFFSET ?",vec![query.clone().into(),p.limit().into(),p.offset().into()]).await?;
    let total =
        s.db.one(
            "SELECT count(*) AS n FROM search_index WHERE search_index MATCH ?",
            vec![query.into()],
        )
        .await?;
    Ok(Json(json!({"items":rows,"total":total["n"]})))
}

#[derive(Deserialize)]
pub struct Import {
    provider: String,
    path: String,
}
pub async fn import(State(s): State<AppState>, Json(input): Json<Import>) -> ApiResult {
    let _guard = s.ingest_lock.lock().await;
    Ok(Json(
        ingestion::ingest(&s.db, &input.provider, std::path::Path::new(&input.path)).await?,
    ))
}

pub async fn discover() -> ApiResult {
    Ok(Json(
        json!({"codex":ingestion::discover("codex"),"claude":ingestion::discover("claude")}),
    ))
}

pub async fn scan(s: &AppState) -> Vec<Value> {
    let _guard = s.ingest_lock.lock().await;
    let mut results = vec![];
    for provider in ["codex", "claude"] {
        for path in ingestion::discover(provider) {
            match ingestion::ingest(&s.db, provider, std::path::Path::new(&path)).await {
                Ok(r) => results.push(r),
                Err(e) => results.push(json!({"path":path,"error":e.to_string()})),
            }
        }
    }
    results
}
pub async fn scan_all(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!(scan(&s).await)))
}
