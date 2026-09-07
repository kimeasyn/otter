use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

pub async fn run(path: &Path, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Git command timed out")??;
    if !output.status.success() {
        bail!("Git: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned())
}

pub async fn root(path: &Path) -> Result<PathBuf> {
    let path = path
        .canonicalize()
        .context("Repository path does not exist")?;
    let result = run(&path, &["rev-parse", "--show-toplevel"]).await?;
    Ok(PathBuf::from(result).canonicalize()?)
}

pub async fn branches(path: &Path) -> Result<Vec<String>> {
    Ok(run(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )
    .await?
    .lines()
    .map(str::to_owned)
    .collect())
}

pub async fn default_branch(path: &Path) -> Result<String> {
    let branches = branches(path).await?;
    for candidate in ["main", "master"] {
        if branches.iter().any(|b| b == candidate) {
            return Ok(candidate.into());
        }
    }
    let branch = run(path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    if !branches.contains(&branch) {
        bail!("Repository needs an initial commit before registration");
    }
    Ok(branch)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub base_branch: String,
    pub base_commit: Option<String>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub dirty: bool,
    pub changed_files: Vec<String>,
    pub locked: bool,
    pub missing: bool,
    pub warning: Option<String>,
}

pub async fn snapshot(path: &Path, base: &str) -> Result<Worktree> {
    let head = run(path, &["rev-parse", "HEAD"]).await?;
    let branch = run(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok();
    let base_commit = run(
        path,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )
    .await
    .ok();
    let counts = run(
        path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...HEAD"),
        ],
    )
    .await
    .ok();
    let counts: Vec<u64> = counts
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    let status = run(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let mut files = Vec::new();
    let mut entries = status.split('\0');
    while let Some(entry) = entries.next() {
        if entry.len() >= 4 {
            files.push(entry[3..].to_owned());
            if entry.starts_with('R') || entry.starts_with('C') {
                entries.next();
            }
        }
    }
    if base_commit.is_some() {
        let diff = run(
            path,
            &["diff", "--name-only", "-z", &format!("{base}...HEAD"), "--"],
        )
        .await?;
        files.extend(
            diff.split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        );
    }
    files.sort();
    files.dedup();
    Ok(Worktree {
        path: path.to_string_lossy().into(),
        branch,
        head,
        base_branch: base.into(),
        base_commit,
        ahead: counts.get(1).copied(),
        behind: counts.first().copied(),
        dirty: !status.is_empty(),
        changed_files: files,
        locked: false,
        missing: false,
        warning: if counts.len() != 2 {
            Some("Base branch cannot be resolved".into())
        } else {
            None
        },
    })
}

pub async fn discover(path: &Path, base: &str) -> Result<Vec<Worktree>> {
    let raw = run(path, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut out = Vec::new();
    for block in raw.split("\0\0") {
        let fields: Vec<_> = block.split('\0').collect();
        let Some(p) = fields.iter().find_map(|s| s.strip_prefix("worktree ")) else {
            continue;
        };
        let mut state = match snapshot(Path::new(p), base).await {
            Ok(s) => s,
            Err(e) => Worktree {
                path: p.into(),
                branch: fields
                    .iter()
                    .find_map(|s| s.strip_prefix("branch refs/heads/"))
                    .map(str::to_owned),
                head: fields
                    .iter()
                    .find_map(|s| s.strip_prefix("HEAD "))
                    .unwrap_or("")
                    .into(),
                base_branch: base.into(),
                base_commit: None,
                ahead: None,
                behind: None,
                dirty: false,
                changed_files: vec![],
                locked: false,
                missing: true,
                warning: Some(e.to_string()),
            },
        };
        state.locked = fields.iter().any(|s| s.starts_with("locked"));
        out.push(state);
    }
    Ok(out)
}

pub async fn create_worktree(repo: &Path, path: &Path, branch: &str, base: &str) -> Result<()> {
    if branch.starts_with('-') || base.starts_with('-') {
        bail!("Invalid branch name");
    }
    run(repo, &["check-ref-format", "--branch", branch]).await?;
    if path.exists() {
        bail!("Worktree path already exists: {}", path.display());
    }
    run(
        repo,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )
    .await?;
    run(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            &path.to_string_lossy(),
            base,
        ],
    )
    .await?;
    Ok(())
}
