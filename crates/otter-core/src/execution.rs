use crate::{db::Db, git, id, now, providers, work};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{watch, Mutex},
};

#[derive(Clone)]
pub struct Executor {
    db: Db,
    running: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}
impl Executor {
    pub fn new(db: Db) -> Self {
        Self {
            db,
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(&self, aid: &str, prompt: String) -> Result<Value> {
        if prompt.trim().is_empty() || prompt.len() > 128000 {
            bail!("Agent request must contain 1–128,000 bytes");
        }
        let agent=self.db.one("SELECT a.*,p.provider,p.model,p.role,p.instructions,p.permissions FROM agent_instances a JOIN agent_profiles p ON p.id=a.profile_id WHERE a.id=?",vec![aid.into()]).await?;
        let uid = agent["work_unit_id"]
            .as_str()
            .context("Agent has no Work Unit")?;
        let unit = self
            .db
            .one("SELECT * FROM work_units WHERE id=?", vec![uid.into()])
            .await?;
        if unit["status"] == "archived" {
            bail!("Restore the archived Work Unit before starting an agent");
        }
        let cwd = unit["worktree_path"]
            .as_str()
            .context("No worktree assigned")?;
        let snapshot = git::snapshot(
            Path::new(cwd),
            unit["base_branch"].as_str().unwrap_or("main"),
        )
        .await?;
        if snapshot.branch.as_deref() != unit["branch"].as_str() {
            bail!("Worktree branch changed; restore the Work Unit branch before agent execution");
        }
        let provider = agent["provider"].as_str().context("No provider assigned")?;
        let detection = providers::detect(provider).await;
        if detection["capabilities"]["one_shot"] != true {
            bail!(
                "{} cannot execute: {}",
                detection["name"],
                detection["note"]
            );
        }
        let mut running = self.running.lock().await;
        if running.contains_key(aid) {
            bail!("Agent is already running");
        }
        let active=self.db.rows("SELECT id FROM agent_instances WHERE work_unit_id=? AND status IN ('running','starting','stopping')",vec![uid.into()]).await?;
        if !active.is_empty() {
            bail!("Another agent is active in this Work Unit; stop it or wait for completion");
        }
        let (cancel, receiver) = watch::channel(false);
        let sid = id();
        let process_id = id();
        let mut tx = self.db.0.begin().await?;
        sqlx::query("INSERT INTO provider_sessions(id,provider,external_session_id,project_id,worktree_id,work_unit_id,agent_id,title,cwd,started_at,last_seen_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'running')")
            .bind(&sid).bind(provider).bind(format!("otter:{sid}")).bind(unit["project_id"].as_str()).bind(agent["worktree_id"].as_str()).bind(uid).bind(aid)
            .bind(format!("{} · {}",agent["name"].as_str().unwrap_or("Agent"),unit["title"].as_str().unwrap_or("Work Unit"))).bind(cwd).bind(now()).bind(now()).execute(&mut *tx).await?;
        sqlx::query("UPDATE agent_instances SET status='running',provider_session_id=?,started_at=?,ended_at=NULL,error=NULL,result=NULL,pid=NULL WHERE id=?")
            .bind(&sid).bind(now()).bind(aid).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO processes(id,work_unit_id,agent_id,kind,cwd,status,started_at) VALUES(?,?,?,'agent',?,'running',?)")
            .bind(&process_id).bind(uid).bind(aid).bind(cwd).bind(now()).execute(&mut *tx).await?;
        sqlx::query("UPDATE work_units SET status='active',completed_at=NULL WHERE id=?")
            .bind(uid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO timeline(work_unit_id,agent_id,kind,text,created_at) VALUES(?,?,'agent.started',?,?)")
            .bind(uid).bind(aid).bind(format!("{} started ({provider})",agent["name"].as_str().unwrap_or("Agent"))).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        running.insert(aid.into(), cancel);
        drop(running);
        let engine = self.clone();
        let session_id = sid.clone();
        let agent_id = aid.to_owned();
        tokio::spawn(async move {
            let full_prompt = format!(
                "{}\n\nWork Unit: {}\n{}\n\nRequest:\n{}",
                agent["instructions"].as_str().unwrap_or(""),
                unit["title"].as_str().unwrap_or(""),
                unit["description"].as_str().unwrap_or(""),
                prompt
            );
            let result = engine
                .perform(
                    &agent,
                    &unit,
                    &session_id,
                    &process_id,
                    &full_prompt,
                    receiver,
                )
                .await;
            if let Err(error) = engine
                .finish(&agent, &session_id, &process_id, result)
                .await
            {
                tracing::error!(error=%error,"Otter could not persist agent completion");
            }
            engine.running.lock().await.remove(&agent_id);
        });
        Ok(json!({"session_id":sid,"agent_id":aid,"status":"running"}))
    }

    pub async fn stop(&self, aid: &str) -> Result<()> {
        let running = self.running.lock().await;
        let sender = running
            .get(aid)
            .context("Agent is not owned by this daemon or has already stopped")?;
        sender.send(true).context("Agent has already stopped")?;
        Ok(())
    }

    pub async fn shutdown(&self) {
        for sender in self.running.lock().await.values() {
            let _ = sender.send(true);
        }
        for _ in 0..100 {
            if self.running.lock().await.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    async fn event(
        &self,
        sid: &str,
        seq: i64,
        raw: Value,
        events: Vec<providers::Event>,
    ) -> Result<()> {
        let mut tx = self.db.0.begin().await?;
        let raw_id:i64=sqlx::query_scalar("INSERT INTO raw_events(session_id,source_sequence,timestamp,source_event_type,raw_json,checksum) VALUES(?,?,?,?,?,?) RETURNING id")
            .bind(sid).bind(seq).bind(now()).bind(raw["type"].as_str().unwrap_or("otter.event")).bind(raw.to_string()).bind(format!("managed:{seq}")).fetch_one(&mut *tx).await?;
        for e in events {
            sqlx::query("INSERT INTO normalized_events(session_id,raw_event_id,timestamp,kind,text,target,detail_json) VALUES(?,?,?,?,?,?,?)")
                .bind(sid).bind(raw_id).bind(now()).bind(&e.kind).bind(&e.text).bind(&e.target).bind(e.detail.to_string()).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE provider_sessions SET last_seen_at=? WHERE id=?")
            .bind(now())
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn perform(
        &self,
        agent: &Value,
        unit: &Value,
        sid: &str,
        process_id: &str,
        prompt: &str,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<String> {
        let user = providers::Event {
            kind: "user.message".into(),
            text: prompt.into(),
            target: None,
            detail: json!({}),
        };
        self.event(
            sid,
            0,
            json!({"type":"otter.prompt","text":prompt}),
            vec![user],
        )
        .await?;
        if agent["provider"] == "fake" {
            let role = agent["role"].as_str().unwrap_or("planner");
            let task = unit["title"].as_str().unwrap_or("Task");
            let output=match role {
                "planner"=>format!("Synthetic plan for {task}:\n1. Inspect relevant code and existing tests.\n2. Implement the requested change.\n3. Run regression tests and review the diff.\nRisk: this is simulated planning; a real provider must inspect actual code."),
                "builder"=>format!("Synthetic implementation result for {task}: simulated a change to src/example.rs and a passing test command. No real files were changed and no tests were actually executed."),
                _=>format!("Synthetic review for {task}: checked the simulated handoff. No real code review was performed. A developer must verify the actual diff and test evidence before merging."),
            };
            let events = vec![
                providers::Event {
                    kind: "tool.file_read".into(),
                    text: "Simulated repository inspection".into(),
                    target: Some("src/example.rs".into()),
                    detail: json!({"synthetic":true}),
                },
                providers::Event {
                    kind: if role == "builder" {
                        "tool.file_write"
                    } else {
                        "tool.search"
                    }
                    .into(),
                    text: format!("Simulated {role} activity"),
                    target: Some("src/example.rs".into()),
                    detail: json!({"synthetic":true}),
                },
                providers::Event {
                    kind: "tool.shell".into(),
                    text: "cargo test (simulated)".into(),
                    target: None,
                    detail: json!({"synthetic":true,"exit_code":0,"output":"3 simulated tests passed"}),
                },
                providers::Event {
                    kind: "assistant.message".into(),
                    text: output.clone(),
                    target: None,
                    detail: json!({"synthetic":true}),
                },
            ];
            for (i, event) in events.into_iter().enumerate() {
                tokio::select! {_ = cancel.changed()=>bail!("Stopped by user"),_ = tokio::time::sleep(std::time::Duration::from_millis(250))=>{}}
                if prompt.contains("[fake:fail]") && i == 1 {
                    bail!("Synthetic provider failure requested by [fake:fail]");
                }
                self.event(
                    sid,
                    i as i64 + 1,
                    serde_json::to_value(&event)?,
                    vec![event],
                )
                .await?;
            }
            return Ok(output);
        }
        let provider = agent["provider"].as_str().context("Provider missing")?;
        let mut command = tokio::process::Command::new(providers::executable(provider));
        if provider == "codex" {
            command.args([
                "exec",
                "--json",
                "--color",
                "never",
                "-c",
                "approval_policy=\"never\"",
                "--sandbox",
                if agent["role"] == "builder" {
                    "workspace-write"
                } else {
                    "read-only"
                },
            ]);
            if let Some(model) = agent["model"].as_str().filter(|m| !m.is_empty()) {
                command.args(["--model", model]);
            }
            command.arg("-");
        } else {
            command.args([
                "--print",
                "--verbose",
                "--output-format",
                "stream-json",
                "--permission-mode",
                "default",
            ]);
            if let Some(model) = agent["model"].as_str().filter(|m| !m.is_empty()) {
                command.args(["--model", model]);
            }
            if agent["role"] != "builder" {
                command.args(["--tools", "Read,Glob,Grep"]);
            }
        }
        command
            .current_dir(unit["worktree_path"].as_str().context("Worktree missing")?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .context("Failed to start provider executable")?;
        let pid = child.id().context("Provider PID unavailable")?;
        let _group = OwnedGroup(pid);
        self.db
            .execute(
                "UPDATE agent_instances SET pid=? WHERE id=?",
                vec![pid.into(), agent["id"].clone()],
            )
            .await?;
        self.db
            .execute(
                "UPDATE processes SET pid=? WHERE id=?",
                vec![pid.into(), process_id.into()],
            )
            .await?;
        let mut stdin = child.stdin.take().context("Provider stdin unavailable")?;
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let stdout = child.stdout.take().context("Provider stdout unavailable")?;
        let mut stderr = child.stderr.take().context("Provider stderr unavailable")?;
        let errors = tokio::spawn(async move {
            let mut buffer = Vec::new();
            let mut chunk = [0; 8192];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let keep = n.min((64 * 1024usize).saturating_sub(buffer.len()));
                buffer.extend_from_slice(&chunk[..keep]);
            }
            String::from_utf8_lossy(&buffer).to_string()
        });
        let mut lines = BufReader::new(stdout);
        let mut sequence = 1;
        let mut last = String::new();
        let adapter = providers::adapter(provider)?;
        let mut failure = None;
        loop {
            let line = tokio::select! {
                _=cancel.changed()=>{failure=Some("Stopped by user".to_string());break;},
                line=read_record(&mut lines)=>line?,
            };
            let Some(line) = line else {
                break;
            };
            let raw = serde_json::from_slice::<Value>(&line)
                .unwrap_or(json!({"type":"unparsed.stdout","text":String::from_utf8_lossy(&line)}));
            let events = adapter.normalize(&raw);
            for e in &events {
                if e.kind == "assistant.message" {
                    last = e.text.clone();
                }
                if e.kind == "session.error" {
                    failure = Some(e.text.clone());
                }
            }
            self.event(sid, sequence, raw, events).await?;
            sequence += 1;
        }
        if failure.is_some() {
            terminate_group(pid);
            let _ = child.kill().await;
        }
        let status = tokio::select! {status=child.wait()=>status?,_=cancel.changed()=>{terminate_group(pid);let _=child.kill().await;failure=Some("Stopped by user".into());child.wait().await?}};
        let errors = errors.await.unwrap_or_default();
        if let Some(error) = failure {
            bail!("{error}");
        }
        if !status.success() {
            bail!(
                "Provider exited with {}: {}",
                status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into()),
                errors.chars().take(2000).collect::<String>()
            );
        }
        if last.is_empty() {
            bail!(
                "Provider exited without a recognized final response; inspect Raw session records"
            );
        }
        Ok(last)
    }

    async fn finish(
        &self,
        agent: &Value,
        sid: &str,
        process_id: &str,
        result: Result<String>,
    ) -> Result<()> {
        let uid = agent["work_unit_id"]
            .as_str()
            .context("Work Unit missing")?;
        let aid = agent["id"].as_str().context("Agent missing")?;
        let (status, body, error) = match result {
            Ok(body) => ("completed", Some(body), None),
            Err(error) => {
                let text = error.to_string();
                (
                    if text == "Stopped by user" {
                        "stopped"
                    } else {
                        "failed"
                    },
                    None,
                    Some(text),
                )
            }
        };
        let mut tx = self.db.0.begin().await?;
        sqlx::query(
            "UPDATE agent_instances SET status=?,result=?,error=?,pid=NULL,ended_at=? WHERE id=?",
        )
        .bind(status)
        .bind(&body)
        .bind(&error)
        .bind(now())
        .bind(aid)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE provider_sessions SET status=?,last_seen_at=? WHERE id=?")
            .bind(status)
            .bind(now())
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE processes SET status=?,ended_at=?,pid=NULL WHERE id=?")
            .bind(status)
            .bind(now())
            .bind(process_id)
            .execute(&mut *tx)
            .await?;
        if let Some(body) = body {
            sqlx::query("INSERT INTO artifacts(id,work_unit_id,agent_id,session_id,kind,body,created_at) VALUES(?,?,?,?,?,?,?)").bind(id()).bind(uid).bind(aid).bind(sid).bind(agent["role"].as_str()).bind(body).bind(now()).execute(&mut *tx).await?;
        }
        let work_status = if status == "failed" {
            "failed"
        } else if status == "completed" && agent["role"] == "reviewer" {
            "review"
        } else {
            "waiting"
        };
        sqlx::query("UPDATE work_units SET status=? WHERE id=?")
            .bind(work_status)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO timeline(work_unit_id,agent_id,kind,text,detail_json,created_at) VALUES(?,?,?,?,?,?)").bind(uid).bind(aid).bind(format!("agent.{status}")).bind(format!("{} {status}",agent["name"].as_str().unwrap_or("Agent"))).bind(json!({"session_id":sid,"error":error,"synthetic":agent["provider"]=="fake"}).to_string()).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn next(&self, uid: &str) -> Result<Value> {
        let unit = self
            .db
            .one("SELECT * FROM work_units WHERE id=?", vec![uid.into()])
            .await?;
        let team = work::team(&self.db, uid).await?;
        if team.iter().any(|a| a["status"] == "running") {
            bail!("Wait for the active agent to finish");
        }
        let mut previous: Option<&Value> = None;
        for role in ["planner", "builder", "reviewer"] {
            let agent = team
                .iter()
                .find(|a| a["role"] == role)
                .with_context(|| format!("Add a {role} agent to use this workflow"))?;
            if agent["status"] == "completed" {
                previous = Some(agent);
                continue;
            }
            let snapshot = git::snapshot(
                Path::new(unit["worktree_path"].as_str().unwrap_or("")),
                unit["base_branch"].as_str().unwrap_or("main"),
            )
            .await?;
            let diff = git::run(
                Path::new(&snapshot.path),
                &[
                    "diff",
                    "--stat",
                    unit["base_branch"].as_str().unwrap_or("main"),
                    "--",
                ],
            )
            .await?;
            let plan=self.db.rows("SELECT body FROM artifacts WHERE work_unit_id=? AND kind='planner' ORDER BY created_at DESC LIMIT 1",vec![uid.into()]).await?;
            let payload = json!({"work_unit_id":uid,"source_agent_id":previous.map(|a|&a["id"]),"destination_agent_id":agent["id"],"original_task":{"title":unit["title"],"description":unit["description"]},"source_session":previous.map(|a|&a["provider_session_id"]),"base_commit":unit["base_commit"],"head":snapshot.head,"changed_files":snapshot.changed_files,"git_diff_summary":diff,"planner_plan":plan.first().map(|p|&p["body"]),"previous_result":previous.map(|a|&a["result"]),"known_problems":previous.map(|a|&a["error"]),"next_requested_action":format!("Perform the {role} role and report your result")});
            let started = self
                .start(
                    agent["id"].as_str().context("Agent missing")?,
                    format!(
                        "Structured handoff:\n{}",
                        serde_json::to_string_pretty(&payload)?
                    ),
                )
                .await?;
            if let Some(source) = previous {
                let mut payload = payload;
                payload["destination_session"] = started["session_id"].clone();
                let hid = id();
                self.db.execute("INSERT INTO handoffs(id,work_unit_id,source_agent_id,destination_agent_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",vec![hid.clone().into(),uid.into(),source["id"].clone(),agent["id"].clone(),payload,now().into()]).await?;
                self.db.execute("INSERT INTO timeline(work_unit_id,agent_id,kind,text,detail_json,created_at) VALUES(?,?,'workflow.handoff',?,?,?)",vec![uid.into(),agent["id"].clone(),format!("{} → {}",source["name"].as_str().unwrap_or("Agent"),agent["name"].as_str().unwrap_or("Agent")).into(),json!({"handoff_id":hid}),now().into()]).await?;
            }
            return Ok(started);
        }
        bail!(
            "Planner, Builder and Reviewer have completed. Inspect the artifacts and merge status."
        )
    }
}

#[cfg(unix)]
fn terminate_group(pid: u32) {
    // Only invoked for a live child created by this Executor, never a persisted PID.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}
#[cfg(not(unix))]
fn terminate_group(_pid: u32) {}

struct OwnedGroup(u32);
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        terminate_group(self.0);
    }
}

async fn read_record<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>> {
    let mut record = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if record.is_empty() {
                None
            } else {
                Some(record)
            });
        }
        let end = available.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let n = end.unwrap_or(available.len());
        if record.len() + n > 4 * 1024 * 1024 {
            bail!("Provider output record exceeds 4 MiB");
        }
        record.extend_from_slice(&available[..n]);
        reader.consume(n);
        if end.is_some() {
            return Ok(Some(record));
        }
    }
}
