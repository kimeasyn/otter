use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use otter_core::{db::Db, git, id, now};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use subtle::ConstantTimeEq;
pub mod directories;
pub mod history;
pub mod terminal;
pub mod units;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub token: Arc<String>,
    pub dev_no_auth: bool,
    pub ingest_lock: Arc<tokio::sync::Mutex<()>>,
    pub executor: otter_core::execution::Executor,
    pub terminal_shutdown: tokio::sync::watch::Sender<bool>,
}

impl AppState {
    pub fn new(db: Db, token: String) -> Self {
        Self {
            executor: otter_core::execution::Executor::new(db.clone()),
            terminal_shutdown: tokio::sync::watch::channel(false).0,
            db,
            token: Arc::new(token),
            dev_no_auth: false,
            ingest_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}

pub struct ApiError(pub anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Do not log request bodies, prompts, environment, or credentials.
        tracing::warn!(
            "Otter API operation failed; private details returned only to the authenticated caller"
        );
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":self.0.to_string()})),
        )
            .into_response()
    }
}
pub type ApiResult = Result<Json<Value>, ApiError>;

async fn auth(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let local = host.starts_with("127.0.0.1:") || host.starts_with("localhost:");
    if !local {
        return (StatusCode::FORBIDDEN, "Local Host header required").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(format!("http://{host}").as_str()) {
            return (StatusCode::FORBIDDEN, "Cross-origin API access is disabled").into_response();
        }
    }
    if s.dev_no_auth {
        if let Some(site) = req.headers().get("sec-fetch-site") {
            if !matches!(site.to_str(), Ok("same-origin" | "none")) {
                return (
                    StatusCode::FORBIDDEN,
                    "Cross-site development API access is disabled",
                )
                    .into_response();
            }
        }
    }
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| {
            if req.uri().path().ends_with("/terminals/ws") {
                req.headers()
                    .get("sec-websocket-protocol")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| {
                        v.split(',')
                            .map(str::trim)
                            .find_map(|p| p.strip_prefix("otter.auth."))
                    })
            } else {
                None
            }
        })
        .unwrap_or("");
    if !s.dev_no_auth && !bool::from(supplied.as_bytes().ct_eq(s.token.as_bytes())) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Otter authentication required"})),
        )
            .into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

pub fn router(state: AppState, web: PathBuf) -> Router {
    let api = Router::new()
        .route(
            "/health",
            get(|State(s): State<AppState>| async move { Json(json!({"name":"Otter","version":env!("CARGO_PKG_VERSION"),"dev_no_auth":s.dev_no_auth})) }),
        )
        .route("/projects", get(projects).post(add_project))
        .route("/directories", get(directories::browse))
        .route("/projects/{id}", get(project_detail).delete(remove_project))
        .route("/projects/{id}/commits", get(project_commits))
        .route("/terminals/ws", get(terminal::upgrade))
        .route("/providers", get(history::providers_list))
        .route("/profiles", get(units::profiles).post(units::add_profile))
        .route("/work-units", get(units::list).post(units::create))
        .route("/work-units/{id}", get(units::detail))
        .route(
            "/work-units/{id}/status",
            axum::routing::post(units::status),
        )
        .route("/work-units/{id}/next", axum::routing::post(units::next))
        .route(
            "/work-units/{id}/message",
            axum::routing::post(units::address),
        )
        .route(
            "/work-units/{id}/agents",
            axum::routing::post(units::add_agent),
        )
        .route(
            "/agents/{id}",
            axum::routing::put(units::edit_agent).delete(units::delete_agent),
        )
        .route(
            "/agents/{id}/start",
            axum::routing::post(units::start_agent),
        )
        .route("/agents/{id}/stop", axum::routing::post(units::stop_agent))
        .route("/sessions", get(history::sessions))
        .route("/sessions/{id}", get(history::session))
        .route("/sessions/{id}/events", get(history::events))
        .route("/search", get(history::search))
        .route("/history/discover", get(history::discover))
        .route("/history/import", axum::routing::post(history::import))
        .route("/history/scan", axum::routing::post(history::scan_all))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .nest("/api", api)
        .fallback_service(
            tower_http::services::ServeDir::new(web).append_index_html_on_directories(true),
        )
        .with_state(state)
        .layer(middleware::from_fn(security_headers))
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    for (key,value) in [
        ("x-content-type-options","nosniff"),
        ("referrer-policy","no-referrer"),
        ("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
    ] {response.headers_mut().insert(axum::http::HeaderName::from_static(key),value.parse().unwrap());}
    response
}

async fn projects(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!(
        s.db.rows(
            "SELECT * FROM projects WHERE removed_at IS NULL ORDER BY name",
            vec![]
        )
        .await?
    )))
}

#[derive(Deserialize)]
struct CommitQuery {
    limit: Option<usize>,
}

async fn project_commits(
    State(s): State<AppState>,
    Path(pid): Path<String>,
    Query(query): Query<CommitQuery>,
) -> ApiResult {
    let project =
        s.db.one(
            "SELECT root_path FROM projects WHERE id=? AND removed_at IS NULL",
            vec![pid.into()],
        )
        .await?;
    let root = PathBuf::from(project["root_path"].as_str().unwrap_or_default());
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let mut commits = git::commits(&root, limit + 1).await?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(Json(json!({"items":commits,"has_more":has_more})))
}

#[derive(Deserialize)]
struct NewProject {
    path: String,
    name: Option<String>,
}
async fn add_project(State(s): State<AppState>, Json(input): Json<NewProject>) -> ApiResult {
    let root = git::root(std::path::Path::new(&input.path)).await?;
    let base = git::default_branch(&root).await?;
    let name = input
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
    let pid = id();
    // Atomic and idempotent, including concurrent adds and restored registrations.
    // Keep the original ID so Work Units and session associations remain intact.
    Ok(Json(s.db.one("INSERT INTO projects(id,name,root_path,base_branch,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(root_path) DO UPDATE SET removed_at=NULL,updated_at=excluded.updated_at RETURNING *",
        vec![pid.into(),name.into(),root.to_string_lossy().to_string().into(),base.into(),now().into(),now().into()]).await?))
}

async fn remove_project(State(s): State<AppState>, Path(pid): Path<String>) -> ApiResult {
    // Database-only registration change. Never call Git, filesystem deletion,
    // worktree cleanup, or process cancellation here, even for missing folders.
    let project = s.db.one(
        "UPDATE projects SET removed_at=coalesce(removed_at,?),updated_at=? WHERE id=? RETURNING id,name",
        vec![now().into(),now().into(),pid.into()],
    ).await?;
    Ok(Json(
        json!({"id":project["id"],"name":project["name"],"removed":true,"files_untouched":true}),
    ))
}

pub async fn scan_project(s: &AppState, pid: &str) -> anyhow::Result<Value> {
    let project =
        s.db.one(
            "SELECT * FROM projects WHERE id=? AND removed_at IS NULL",
            vec![pid.into()],
        )
        .await?;
    let root = PathBuf::from(project["root_path"].as_str().unwrap_or_default());
    let base = project["base_branch"].as_str().unwrap_or("main");
    let trees = git::discover(&root, base).await?;
    let mut views = vec![];
    for mut tree in trees {
        let prior =
            s.db.rows(
                "SELECT id,state_json FROM worktrees WHERE path=?",
                vec![tree.path.clone().into()],
            )
            .await?;
        let tid = prior
            .first()
            .and_then(|v| v["id"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(id);
        let unit=s.db.rows("SELECT id,base_branch FROM work_units WHERE project_id=? AND worktree_path=? ORDER BY created_at DESC LIMIT 1",vec![pid.into(),tree.path.clone().into()]).await?;
        let uid = unit.first().map(|u| u["id"].clone()).unwrap_or(Value::Null);
        let tree_base = unit
            .first()
            .and_then(|u| u["base_branch"].as_str())
            .unwrap_or(base);
        if tree_base != base && !tree.missing {
            let locked = tree.locked;
            tree = git::snapshot(std::path::Path::new(&tree.path), tree_base).await?;
            tree.locked = locked;
        }
        let state = serde_json::to_value(&tree)?;
        s.db.execute("INSERT INTO worktrees(id,project_id,work_unit_id,path,branch,head_commit,base_branch,base_commit,state_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET work_unit_id=excluded.work_unit_id,branch=excluded.branch,head_commit=excluded.head_commit,base_branch=excluded.base_branch,base_commit=excluded.base_commit,state_json=excluded.state_json,updated_at=excluded.updated_at",
            vec![tid.clone().into(),pid.into(),uid.clone(),tree.path.clone().into(),json!(tree.branch),tree.head.into(),tree_base.into(),json!(tree.base_commit),state.clone(),now().into()]).await?;
        // History may have been indexed before this project was registered. Exact
        // cwd identifies its repository, but does not prove a later Work Unit link.
        s.db.execute("UPDATE provider_sessions SET project_id=coalesce(project_id,?),worktree_id=coalesce(worktree_id,?) WHERE cwd=? AND (project_id IS NULL OR project_id=?) AND (worktree_id IS NULL OR worktree_id=?)",
            vec![pid.into(),tid.clone().into(),tree.path.clone().into(),pid.into(),tid.clone().into()]).await?;
        if prior.first().map(|v| &v["state_json"]) != Some(&state) {
            s.db.execute(
                "INSERT INTO git_snapshots(worktree_id,state_json,created_at) VALUES(?,?,?)",
                vec![tid.clone().into(), state.clone(), now().into()],
            )
            .await?;
        }
        let agents=s.db.rows("SELECT a.id,a.name,a.status,p.provider,p.role FROM agent_instances a JOIN agent_profiles p ON p.id=a.profile_id WHERE a.work_unit_id=?",vec![uid.clone()]).await?;
        let mut view = state;
        view["id"] = tid.into();
        view["work_unit_id"] = uid;
        view["agents"] = json!(agents);
        views.push(view);
    }
    let units =
        s.db.rows(
            "SELECT * FROM work_units WHERE project_id=? ORDER BY created_at DESC",
            vec![pid.into()],
        )
        .await?;
    Ok(
        json!({"project":project,"branches":git::branches(&root).await?,"worktrees":views,"work_units":units}),
    )
}

async fn project_detail(State(s): State<AppState>, Path(pid): Path<String>) -> ApiResult {
    Ok(Json(scan_project(&s, &pid).await?))
}
