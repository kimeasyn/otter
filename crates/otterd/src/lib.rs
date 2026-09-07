use axum::{
    extract::{Path, Request, State},
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

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub token: Arc<String>,
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
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !bool::from(supplied.as_bytes().ct_eq(s.token.as_bytes())) {
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
            get(|| async { Json(json!({"name":"Otter","version":env!("CARGO_PKG_VERSION")})) }),
        )
        .route("/projects", get(projects).post(add_project))
        .route("/projects/{id}", get(project_detail))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .nest("/api", api)
        .fallback_service(
            tower_http::services::ServeDir::new(web).append_index_html_on_directories(true),
        )
        .with_state(state)
}

async fn projects(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!(
        s.db.rows("SELECT * FROM projects ORDER BY name", vec![])
            .await?
    )))
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
    s.db.execute("INSERT INTO projects(id,name,root_path,base_branch,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        vec![pid.clone().into(),name.into(),root.to_string_lossy().to_string().into(),base.into(),now().into(),now().into()]).await?;
    Ok(Json(
        s.db.one("SELECT * FROM projects WHERE id=?", vec![pid.into()])
            .await?,
    ))
}

pub async fn scan_project(s: &AppState, pid: &str) -> anyhow::Result<Value> {
    let project =
        s.db.one("SELECT * FROM projects WHERE id=?", vec![pid.into()])
            .await?;
    let root = PathBuf::from(project["root_path"].as_str().unwrap_or_default());
    let base = project["base_branch"].as_str().unwrap_or("main");
    let trees = git::discover(&root, base).await?;
    let mut views = vec![];
    for tree in trees {
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
        let unit=s.db.rows("SELECT id FROM work_units WHERE project_id=? AND worktree_path=? ORDER BY created_at DESC LIMIT 1",vec![pid.into(),tree.path.clone().into()]).await?;
        let uid = unit.first().map(|u| u["id"].clone()).unwrap_or(Value::Null);
        let state = serde_json::to_value(&tree)?;
        s.db.execute("INSERT INTO worktrees(id,project_id,work_unit_id,path,branch,head_commit,base_branch,base_commit,state_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET work_unit_id=excluded.work_unit_id,branch=excluded.branch,head_commit=excluded.head_commit,state_json=excluded.state_json,updated_at=excluded.updated_at",
            vec![tid.clone().into(),pid.into(),uid.clone(),tree.path.clone().into(),json!(tree.branch),tree.head.into(),base.into(),json!(tree.base_commit),state.clone(),now().into()]).await?;
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
