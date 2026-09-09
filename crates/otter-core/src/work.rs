use crate::{db::Db, git, id, now};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Profile {
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub role: String,
    #[serde(default)]
    pub instructions: String,
}
impl Profile {
    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty()
            || self.name.len() > 40
            || !self
                .name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            bail!("Agent names must be 1–40 letters, numbers, underscores or hyphens");
        }
        crate::providers::adapter(&self.provider)?;
        if !["planner", "builder", "reviewer"].contains(&self.role.as_str()) {
            bail!("Choose planner, builder, or reviewer role");
        }
        if self.instructions.len() > 32000 {
            bail!("Agent instructions exceed 32,000 bytes");
        }
        if self
            .model
            .as_ref()
            .is_some_and(|m| m.len() > 150 || m.starts_with('-'))
        {
            bail!("Invalid model identifier");
        }
        Ok(())
    }
    pub fn permissions(&self) -> &str {
        if self.provider == "fake" {
            return "synthetic; no actual filesystem effects";
        }
        if self.provider == "codex" {
            if self.role == "builder" {
                "provider-native: workspace-write"
            } else {
                "provider-native: read-only"
            }
        } else {
            "advisory: role instructions; inspect provider capabilities"
        }
    }
}

pub async fn seed_profiles(db: &Db) -> Result<()> {
    for (role,instructions) in [
        ("planner","Inspect the task and repository. Produce a concise implementation plan, relevant files, and risks. Do not modify files."),
        ("builder","Implement the task using the supplied plan. Run relevant tests and report changes, results, and remaining problems."),
        ("reviewer","Review the task, implementation diff, and test evidence. Report findings and remaining risks. Do not modify files.")
    ] {
        let mut name=role.to_owned();name[..1].make_ascii_uppercase();
        db.execute("INSERT OR IGNORE INTO agent_profiles(id,name,provider,model,role,instructions,permissions,created_at) VALUES(?,?,'fake','deterministic',?,?,'synthetic; no actual filesystem effects',?)",vec![format!("default-{role}").into(),name.into(),role.into(),instructions.into(),now().into()]).await?;
    }
    Ok(())
}

pub async fn save_profile(db: &Db, p: &Profile) -> Result<Value> {
    p.validate()?;
    let pid = id();
    db.execute("INSERT INTO agent_profiles(id,name,provider,model,role,instructions,permissions,created_at) VALUES(?,?,?,?,?,?,?,?)",vec![pid.clone().into(),p.name.clone().into(),p.provider.clone().into(),json!(p.model),p.role.clone().into(),p.instructions.clone().into(),p.permissions().into(),now().into()]).await?;
    db.one("SELECT * FROM agent_profiles WHERE id=?", vec![pid.into()])
        .await
}

#[derive(Debug, Deserialize)]
pub struct NewWork {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub base_branch: String,
    pub branch: String,
    pub worktree_path: String,
    #[serde(default = "yes")]
    pub create_worktree: bool,
    pub team: Vec<Profile>,
}
fn yes() -> bool {
    true
}

pub fn slug(title: &str) -> String {
    let slug = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!(
        "otter/{}",
        if slug.is_empty() {
            "task"
        } else {
            &slug[..slug.len().min(60)]
        }
    )
}

pub async fn fingerprint(path: &Path) -> Value {
    let mut versions = serde_json::Map::new();
    for (name, args) in [
        ("git", vec!["--version"]),
        ("node", vec!["--version"]),
        ("python3", vec!["--version"]),
        ("rustc", vec!["--version"]),
    ] {
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::process::Command::new(name)
                .args(args)
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let version = result
            .ok()
            .and_then(Result::ok)
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
        versions.insert(name.into(), json!(version));
    }
    let mut hashes = serde_json::Map::new();
    for name in [
        "Cargo.lock",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "uv.lock",
        "poetry.lock",
        "compose.yml",
        "compose.yaml",
        "docker-compose.yml",
    ] {
        let file = path.join(name);
        if std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file() && m.len() < 10 * 1024 * 1024)
        {
            if let Ok(bytes) = std::fs::read(file) {
                hashes.insert(name.into(), json!(format!("{:x}", Sha256::digest(bytes))));
            }
        }
    }
    json!({"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"versions":versions,"lockfile_hashes":hashes,"env_file_exists":path.join(".env").exists(),"head":git::run(path,&["rev-parse","HEAD"]).await.ok()})
}

pub async fn create(db: &Db, input: NewWork) -> Result<Value> {
    if input.title.trim().is_empty() || input.title.len() > 200 {
        bail!("Work Unit title must contain 1–200 bytes");
    }
    if input.description.len() > 64000 {
        bail!("Work Unit description exceeds 64,000 bytes");
    }
    if input.team.is_empty() || input.team.len() > 12 {
        bail!("Choose between 1 and 12 agents");
    }
    let mut names = HashSet::new();
    for profile in &input.team {
        profile.validate()?;
        if !names.insert(profile.name.to_lowercase()) {
            bail!("Agent names must be unique within a Work Unit");
        }
    }
    let project = db
        .one(
            "SELECT * FROM projects WHERE id=? AND removed_at IS NULL",
            vec![input.project_id.clone().into()],
        )
        .await?;
    let root = PathBuf::from(
        project["root_path"]
            .as_str()
            .context("Missing repository path")?,
    );
    let branches = git::branches(&root).await?;
    if !branches.contains(&input.base_branch) {
        bail!("Select an existing local base branch");
    }
    let base_commit = git::run(
        &root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", input.base_branch),
        ],
    )
    .await?;
    let path = PathBuf::from(&input.worktree_path);
    if !path.is_absolute() {
        bail!("Worktree path must be absolute");
    }
    let uid = id();
    let tid = id();
    if input.create_worktree {
        git::create_worktree(&root, &path, &input.branch, &base_commit).await?;
    } else {
        let trees = git::discover(&root, &input.base_branch).await?;
        let canonical = path
            .canonicalize()
            .context("Existing worktree does not exist")?;
        if !trees
            .iter()
            .any(|t| Path::new(&t.path) == canonical && t.branch.as_deref() == Some(&input.branch))
        {
            bail!("Select an existing worktree and its currently checked-out branch");
        }
        let assigned=db.rows("SELECT id FROM work_units WHERE worktree_path=? AND status NOT IN ('completed','archived')",vec![canonical.to_string_lossy().to_string().into()]).await?;
        if !assigned.is_empty() {
            bail!("This worktree already belongs to an active Work Unit");
        }
    }
    let persisted=async {
        let canonical=path.canonicalize()?;
        let snapshot=git::snapshot(&canonical,&input.base_branch).await?;
        let environment=fingerprint(&canonical).await;
        let mut tx=db.0.begin().await?;
        sqlx::query("INSERT INTO work_units(id,project_id,title,description,status,base_branch,base_commit,branch,worktree_path,environment_json,created_at) VALUES(?,?,?,?,'draft',?,?,?,?,?,?)")
            .bind(&uid).bind(&input.project_id).bind(input.title.trim()).bind(&input.description).bind(&input.base_branch).bind(&base_commit).bind(&input.branch).bind(canonical.to_string_lossy().as_ref()).bind(environment.to_string()).bind(now()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO worktrees(id,project_id,work_unit_id,path,branch,head_commit,base_branch,base_commit,state_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET work_unit_id=excluded.work_unit_id,base_branch=excluded.base_branch,base_commit=excluded.base_commit,state_json=excluded.state_json,updated_at=excluded.updated_at")
            .bind(&tid).bind(&input.project_id).bind(&uid).bind(canonical.to_string_lossy().as_ref()).bind(&input.branch).bind(&snapshot.head).bind(&input.base_branch).bind(&base_commit).bind(serde_json::to_string(&snapshot)?).bind(now()).execute(&mut *tx).await?;
        let actual_tid:String=sqlx::query_scalar("SELECT id FROM worktrees WHERE path=?").bind(canonical.to_string_lossy().as_ref()).fetch_one(&mut *tx).await?;
        for profile in &input.team {
            let pid=id();
            sqlx::query("INSERT INTO agent_profiles(id,name,provider,model,role,instructions,permissions,created_at) VALUES(?,?,?,?,?,?,?,?)")
                .bind(&pid).bind(&profile.name).bind(&profile.provider).bind(&profile.model).bind(&profile.role).bind(&profile.instructions).bind(profile.permissions()).bind(now()).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO agent_instances(id,work_unit_id,profile_id,name,worktree_id,status) VALUES(?,?,?,?,?,'idle')")
                .bind(id()).bind(&uid).bind(pid).bind(&profile.name).bind(&actual_tid).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO timeline(work_unit_id,kind,text,detail_json,created_at) VALUES(?,'work.created','Work Unit created',?,?)")
            .bind(&uid).bind(json!({"branch":input.branch,"base_commit":base_commit,"worktree_path":canonical}).to_string()).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok::<(),anyhow::Error>(())
    }.await;
    if let Err(error) = persisted {
        if input.create_worktree {
            // Roll back only the new, unchanged worktree that this request created.
            let clean = git::snapshot(&path, &input.base_branch)
                .await
                .is_ok_and(|s| !s.dirty && s.head == base_commit);
            if clean
                && git::run(&root, &["worktree", "remove", &path.to_string_lossy()])
                    .await
                    .is_ok()
            {
                let branch_cleanup = git::run(&root, &["branch", "-d", "--", &input.branch]).await;
                if branch_cleanup.is_err() {
                    bail!(
                        "{error}; worktree rolled back, but branch {} remains",
                        input.branch
                    );
                }
            } else {
                bail!(
                    "{error}; newly created worktree {} and branch {} remain for inspection",
                    path.display(),
                    input.branch
                );
            }
        }
        return Err(error);
    }
    db.one("SELECT * FROM work_units WHERE id=?", vec![uid.into()])
        .await
}

pub fn transition_allowed(from: &str, to: &str) -> bool {
    from == to
        || match from {
            "draft" => matches!(to, "active" | "archived"),
            "active" => matches!(to, "waiting" | "review" | "failed"),
            "waiting" => matches!(to, "active" | "review" | "failed" | "archived"),
            "review" => matches!(to, "active" | "completed" | "failed"),
            "failed" => matches!(to, "active" | "archived"),
            "completed" => matches!(to, "active" | "archived"),
            "archived" => to == "draft",
            _ => false,
        }
}

pub async fn transition(db: &Db, uid: &str, to: &str) -> Result<()> {
    let unit = db
        .one("SELECT status FROM work_units WHERE id=?", vec![uid.into()])
        .await?;
    let from = unit["status"].as_str().unwrap_or_default();
    if !transition_allowed(from, to) {
        bail!("Cannot move Work Unit from {from} to {to}");
    }
    let mut tx = db.0.begin().await?;
    let changed =
        sqlx::query("UPDATE work_units SET status=?,completed_at=? WHERE id=? AND status=?")
            .bind(to)
            .bind(if to == "completed" { Some(now()) } else { None })
            .bind(uid)
            .bind(from)
            .execute(&mut *tx)
            .await?;
    if changed.rows_affected() != 1 {
        bail!("Work Unit changed concurrently; refresh and retry");
    }
    sqlx::query(
        "INSERT INTO timeline(work_unit_id,kind,text,created_at) VALUES(?,'work.status',?,?)",
    )
    .bind(uid)
    .bind(format!("{from} → {to}"))
    .bind(now())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn team(db: &Db, uid: &str) -> Result<Vec<Value>> {
    db.rows("SELECT a.*,p.provider,p.model,p.role,p.instructions,p.permissions FROM agent_instances a JOIN agent_profiles p ON p.id=a.profile_id WHERE a.work_unit_id=? ORDER BY CASE p.role WHEN 'planner' THEN 0 WHEN 'builder' THEN 1 ELSE 2 END,a.name",vec![uid.into()]).await
}

pub fn route_agent<'a>(agents: &'a [Value], message: &str) -> Result<(&'a Value, String)> {
    let message = message.trim();
    let Some(rest) = message.strip_prefix('@') else {
        bail!("Address an agent with @Name followed by your request");
    };
    let (name, prompt) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let agent = agents
        .iter()
        .find(|a| {
            a["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .context("No agent with that name in this Work Unit")?;
    if prompt.trim().is_empty() {
        bail!("Enter a request after @Name");
    }
    Ok((agent, prompt.trim().into()))
}
