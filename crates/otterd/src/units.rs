use crate::{ApiResult, AppState};
use axum::{
    extract::{Path, State},
    Json,
};
use otter_core::{git, id, now, work};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path as FsPath;

pub async fn list(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!(s.db.rows("SELECT w.*,p.name AS project_name FROM work_units w JOIN projects p ON p.id=w.project_id ORDER BY w.created_at DESC LIMIT 1000",vec![]).await?)))
}
pub async fn create(State(s): State<AppState>, Json(input): Json<work::NewWork>) -> ApiResult {
    Ok(Json(work::create(&s.db, input).await?))
}
pub async fn profiles(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!(
        s.db.rows(
            "SELECT * FROM agent_profiles ORDER BY created_at,name",
            vec![]
        )
        .await?
    )))
}
pub async fn add_profile(State(s): State<AppState>, Json(input): Json<work::Profile>) -> ApiResult {
    Ok(Json(work::save_profile(&s.db, &input).await?))
}

pub async fn detail(State(s): State<AppState>, Path(uid): Path<String>) -> ApiResult {
    let unit =
        s.db.one(
            "SELECT * FROM work_units WHERE id=?",
            vec![uid.clone().into()],
        )
        .await?;
    let agents = work::team(&s.db, &uid).await?;
    let path = FsPath::new(unit["worktree_path"].as_str().unwrap_or(""));
    let base = unit["base_branch"].as_str().unwrap_or("main");
    let observation = git::snapshot(path, base).await;
    let mut overlaps = vec![];
    if let Ok(snapshot) = &observation {
        let project =
            s.db.one(
                "SELECT root_path FROM projects WHERE id=?",
                vec![unit["project_id"].clone()],
            )
            .await?;
        for other in git::discover(
            FsPath::new(project["root_path"].as_str().unwrap_or("")),
            base,
        )
        .await
        .unwrap_or_default()
        {
            if other.path != snapshot.path {
                let shared: Vec<_> = snapshot
                    .changed_files
                    .iter()
                    .filter(|p| other.changed_files.contains(p))
                    .cloned()
                    .collect();
                if !shared.is_empty() {
                    overlaps.push(json!({"branch":other.branch,"path":other.path,"files":shared,"label":"Potential overlap; not a confirmed merge conflict"}));
                }
            }
        }
    }
    let reviewer = agents.iter().find(|a| a["role"] == "reviewer");
    let review = reviewer
        .map(|a| json!({"status":a["status"],"synthetic":a["provider"]=="fake"}))
        .unwrap_or(json!({"status":"not assigned","synthetic":false}));
    let commands=s.db.rows("SELECT e.text,e.detail_json,e.timestamp,s.provider,s.id AS session_id FROM normalized_events e JOIN provider_sessions s ON s.id=e.session_id WHERE s.work_unit_id=? AND e.kind='tool.shell' AND s.provider!='fake' ORDER BY e.id DESC LIMIT 200",vec![uid.clone().into()]).await?;
    let test=commands.iter().find_map(|e|{
        let command=e["text"].as_str().unwrap_or("");
        let known=["cargo test","npm test","pnpm test","pytest","python -m pytest","python3 -m pytest","go test","dotnet test"].iter().any(|prefix|command==*prefix||command.starts_with(&format!("{prefix} ")));
        if known {e["detail_json"]["exit_code"].as_i64().map(|code|json!({"status":if code==0{"passed"}else{"failed"},"command":command,"exit_code":code,"timestamp":e["timestamp"],"session_id":e["session_id"],"scope":"Last observed command only; not proof of current HEAD coverage"}))}else{None}
    }).unwrap_or(json!({"status":"unknown","scope":"No recognized real test execution with an exit code"}));
    let readiness = match &observation {
        Err(_) => "UNAVAILABLE",
        Ok(g) if g.branch.as_deref() != unit["branch"].as_str() => "BRANCH CHANGED",
        Ok(g) if g.dirty => "UNCOMMITTED CHANGES",
        Ok(g) if g.behind.unwrap_or(1) > 0 => "NEEDS SYNC",
        Ok(_) if !overlaps.is_empty() => "CHECK OVERLAP",
        Ok(g) if g.ahead.unwrap_or(0) == 0 => "NO COMMITS TO MERGE",
        Ok(_) if test["status"] != "passed" => "TEST EVIDENCE NEEDED",
        Ok(_) if review["status"] != "completed" || review["synthetic"] == true => {
            "REAL REVIEW NEEDED"
        }
        Ok(_) => "READY FOR MANUAL VERIFICATION",
    };
    let (snapshot, git_error) = match observation {
        Ok(g) => (json!(g), Value::Null),
        Err(e) => (Value::Null, json!(e.to_string())),
    };
    let commits=git::run(path,&["log","--max-count=50","--format=%H%x1f%s%x1f%aI",&format!("{base}..HEAD"),"--"]).await.unwrap_or_default().lines().map(|line|{let fields:Vec<_>=line.split('\u{1f}').collect();json!({"hash":fields.first(),"subject":fields.get(1),"timestamp":fields.get(2),"provenance":"Observed on Work Unit branch; authorship by a specific agent is not inferred"})}).collect::<Vec<_>>();
    let timeline =
        s.db.rows(
            "SELECT * FROM timeline WHERE work_unit_id=? ORDER BY id DESC LIMIT 200",
            vec![uid.clone().into()],
        )
        .await?;
    let artifacts =
        s.db.rows(
            "SELECT * FROM artifacts WHERE work_unit_id=? ORDER BY created_at DESC LIMIT 100",
            vec![uid.clone().into()],
        )
        .await?;
    let handoffs =
        s.db.rows(
            "SELECT * FROM handoffs WHERE work_unit_id=? ORDER BY created_at DESC LIMIT 100",
            vec![uid.clone().into()],
        )
        .await?;
    let sessions=s.db.rows("SELECT id,title,provider,status FROM provider_sessions WHERE work_unit_id=? ORDER BY started_at DESC LIMIT 100",vec![uid.into()]).await?;
    Ok(Json(
        json!({"work_unit":unit,"agents":agents,"git":snapshot,"git_error":git_error,"commits":commits,"merge":{"readiness":readiness,"test":test,"review":review,"overlaps":overlaps,"note":"Measured hints only. Otter does not automatically merge or prove merge safety."},"timeline":timeline,"artifacts":artifacts,"handoffs":handoffs,"sessions":sessions}),
    ))
}

#[derive(Deserialize)]
pub struct Status {
    status: String,
}
pub async fn status(
    State(s): State<AppState>,
    Path(uid): Path<String>,
    Json(input): Json<Status>,
) -> ApiResult {
    if !s
        .db
        .rows(
            "SELECT id FROM agent_instances WHERE work_unit_id=? AND status='running'",
            vec![uid.clone().into()],
        )
        .await?
        .is_empty()
    {
        return Err(anyhow::anyhow!("Stop active agents before changing Work Unit status").into());
    }
    work::transition(&s.db, &uid, &input.status).await?;
    Ok(Json(json!({"status":input.status})))
}
pub async fn next(State(s): State<AppState>, Path(uid): Path<String>) -> ApiResult {
    Ok(Json(s.executor.next(&uid).await?))
}
#[derive(Deserialize)]
pub struct Message {
    message: String,
}
pub async fn address(
    State(s): State<AppState>,
    Path(uid): Path<String>,
    Json(input): Json<Message>,
) -> ApiResult {
    let agents = work::team(&s.db, &uid).await?;
    let (agent, prompt) = work::route_agent(&agents, &input.message)?;
    Ok(Json(
        s.executor
            .start(agent["id"].as_str().unwrap_or(""), prompt)
            .await?,
    ))
}
pub async fn start_agent(
    State(s): State<AppState>,
    Path(aid): Path<String>,
    Json(input): Json<Message>,
) -> ApiResult {
    Ok(Json(s.executor.start(&aid, input.message).await?))
}
pub async fn stop_agent(State(s): State<AppState>, Path(aid): Path<String>) -> ApiResult {
    s.executor.stop(&aid).await?;
    Ok(Json(json!({"status":"stop requested"})))
}

pub async fn add_agent(
    State(s): State<AppState>,
    Path(uid): Path<String>,
    Json(input): Json<work::Profile>,
) -> ApiResult {
    input.validate()?;
    let unit =
        s.db.one(
            "SELECT * FROM work_units WHERE id=?",
            vec![uid.clone().into()],
        )
        .await?;
    let count =
        s.db.one(
            "SELECT count(*) AS n FROM agent_instances WHERE work_unit_id=?",
            vec![uid.clone().into()],
        )
        .await?;
    if count["n"].as_i64().unwrap_or(0) >= 12 {
        return Err(anyhow::anyhow!("At most 12 agents per Work Unit").into());
    }
    let profile = work::save_profile(&s.db, &input).await?;
    let aid = id();
    let tree =
        s.db.one(
            "SELECT id FROM worktrees WHERE path=?",
            vec![unit["worktree_path"].clone()],
        )
        .await?;
    s.db.execute("INSERT INTO agent_instances(id,work_unit_id,profile_id,name,worktree_id,status) VALUES(?,?,?,?,?,'idle')",vec![aid.clone().into(),uid.into(),profile["id"].clone(),input.name.into(),tree["id"].clone()]).await?;
    Ok(Json(json!({"id":aid})))
}
pub async fn edit_agent(
    State(s): State<AppState>,
    Path(aid): Path<String>,
    Json(input): Json<work::Profile>,
) -> ApiResult {
    input.validate()?;
    let agent =
        s.db.one(
            "SELECT * FROM agent_instances WHERE id=?",
            vec![aid.clone().into()],
        )
        .await?;
    if agent["status"] == "running" {
        return Err(anyhow::anyhow!("Stop the agent before editing its profile").into());
    }
    let profile = work::save_profile(&s.db, &input).await?;
    s.db.execute("UPDATE agent_instances SET profile_id=?,name=?,status='idle',result=NULL,error=NULL WHERE id=?",vec![profile["id"].clone(),input.name.into(),aid.into()]).await?;
    Ok(Json(profile))
}
pub async fn delete_agent(State(s): State<AppState>, Path(aid): Path<String>) -> ApiResult {
    let agent =
        s.db.one(
            "SELECT * FROM agent_instances WHERE id=?",
            vec![aid.clone().into()],
        )
        .await?;
    if agent["status"] != "idle" || !agent["provider_session_id"].is_null() {
        return Err(anyhow::anyhow!(
            "Only an unused agent can be removed; session provenance must be preserved"
        )
        .into());
    }
    s.db.execute("DELETE FROM agent_instances WHERE id=?", vec![aid.into()])
        .await?;
    Ok(Json(json!({"removed":true,"at":now()})))
}
