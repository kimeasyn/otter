use otter_core::{db::Db, execution::Executor, git, work};
use serde_json::json;

async fn setup() -> (tempfile::TempDir, Db, serde_json::Value) {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git::run(&repo, &["init", "-b", "main"]).await.unwrap();
    git::run(
        &repo,
        &[
            "-c",
            "user.name=Otter Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "baseline",
        ],
    )
    .await
    .unwrap();
    let db = Db::open(&temp.path().join("test.db")).await.unwrap();
    db.execute(
        "INSERT INTO projects(id,name,root_path,base_branch,created_at,updated_at) VALUES('p','Test',?,'main','now','now')",
        vec![repo.to_string_lossy().to_string().into()],
    )
    .await
    .unwrap();
    let team = ["planner", "builder", "reviewer"]
        .iter()
        .map(|r| work::Profile {
            name: r.to_string(),
            provider: "fake".into(),
            model: None,
            role: r.to_string(),
            instructions: String::new(),
        })
        .collect();
    let unit = work::create(
        &db,
        work::NewWork {
            project_id: "p".into(),
            title: "Parser recovery".into(),
            description: "Recover partial lines".into(),
            base_branch: "main".into(),
            branch: "otter/parser".into(),
            worktree_path: temp.path().join("worktree").to_string_lossy().to_string(),
            create_worktree: true,
            team,
        },
    )
    .await
    .unwrap();
    (temp, db, unit)
}

async fn wait(db: &Db, aid: &str) -> serde_json::Value {
    for _ in 0..100 {
        let agent = db
            .one("SELECT * FROM agent_instances WHERE id=?", vec![aid.into()])
            .await
            .unwrap();
        if agent["status"] != "running" {
            return agent;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("FakeProvider failed to finish in five seconds")
}

#[tokio::test]
async fn fake_workflow_handoffs_and_artifacts_survive_restart() {
    let (temp, db, unit) = setup().await;
    let uid = unit["id"].as_str().unwrap();
    let executor = Executor::new(db.clone());
    for _ in 0..3 {
        let run = executor.next(uid).await.unwrap();
        assert_eq!(
            wait(&db, run["agent_id"].as_str().unwrap()).await["status"],
            "completed"
        );
    }
    assert!(executor.next(uid).await.is_err());
    let handoffs = db
        .rows(
            "SELECT payload_json FROM handoffs WHERE work_unit_id=? ORDER BY created_at",
            vec![uid.into()],
        )
        .await
        .unwrap();
    assert_eq!(handoffs.len(), 2);
    assert!(handoffs[0]["payload_json"]["previous_result"]
        .as_str()
        .unwrap()
        .contains("Synthetic plan"));
    assert!(handoffs[1]["payload_json"]["previous_result"]
        .as_str()
        .unwrap()
        .contains("Synthetic implementation"));
    assert!(handoffs[1]["payload_json"]["planner_plan"]
        .as_str()
        .unwrap()
        .contains("Synthetic plan"));
    assert_eq!(
        db.one("SELECT count(*) AS n FROM artifacts", vec![])
            .await
            .unwrap()["n"],
        3
    );
    let tree = git::snapshot(
        std::path::Path::new(unit["worktree_path"].as_str().unwrap()),
        "main",
    )
    .await
    .unwrap();
    assert!(!tree.dirty);
    assert_eq!(tree.ahead, Some(0));
    executor.shutdown().await;
    drop(executor);
    db.0.close().await;
    let db = Db::open(&temp.path().join("test.db")).await.unwrap();
    db.reconcile().await.unwrap();
    assert_eq!(work::team(&db, uid).await.unwrap().len(), 3);
    assert_eq!(
        db.one("SELECT count(*) AS n FROM handoffs", vec![])
            .await
            .unwrap()["n"],
        2
    );
    assert_eq!(
        db.one("SELECT status FROM work_units WHERE id=?", vec![uid.into()])
            .await
            .unwrap()["status"],
        "review"
    );
    assert!(!db
        .rows(
            "SELECT * FROM search_index WHERE search_index MATCH 'recovery'",
            vec![]
        )
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn explicit_routing_cancellation_failure_and_duplicate_start() {
    let (_temp, db, unit) = setup().await;
    let uid = unit["id"].as_str().unwrap();
    let executor = Executor::new(db.clone());
    let agents = work::team(&db, uid).await.unwrap();
    let (agent, prompt) = work::route_agent(&agents, "@BUILDER implement recovery").unwrap();
    assert_eq!(prompt, "implement recovery");
    let aid = agent["id"].as_str().unwrap();
    executor.start(aid, "Simulate work".into()).await.unwrap();
    assert!(executor.start(aid, "Duplicate".into()).await.is_err());
    executor.stop(aid).await.unwrap();
    assert_eq!(wait(&db, aid).await["status"], "stopped");
    // Allow runtime cleanup after durable completion becomes visible.
    executor.shutdown().await;
    executor.start(aid, "[fake:fail]".into()).await.unwrap();
    assert_eq!(wait(&db, aid).await["status"], "failed");
    assert!(work::route_agent(&agents, "@Missing work").is_err());
    assert!(work::route_agent(&agents, "builder work").is_err());
    assert!(work::route_agent(&agents, "@builder").is_err());
    assert!(!work::transition_allowed("draft", "completed"));
    assert!(work::transition_allowed("review", "completed"));
    assert_eq!(work::slug("Fix parser!"), "otter/fix-parser");
    assert_eq!(json!(agents.len()), 3);
}

#[tokio::test]
async fn failed_persistence_rolls_back_only_the_new_worktree() {
    let (temp, db, _unit) = setup().await;
    db.execute("CREATE TRIGGER reject_test_work BEFORE INSERT ON work_units BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END",vec![]).await.unwrap();
    let path = temp.path().join("rollback");
    let request:work::NewWork=serde_json::from_value(json!({"project_id":"p","title":"Rollback test","base_branch":"main","branch":"otter/rollback","worktree_path":path,"team":[{"name":"Planner","provider":"fake","role":"planner","model":null}]})).unwrap();
    let error = work::create(&db, request).await.unwrap_err();
    assert!(error.to_string().contains("simulated storage failure"));
    assert!(!path.exists());
    assert!(git::run(
        &temp.path().join("repo"),
        &["show-ref", "--verify", "refs/heads/otter/rollback"]
    )
    .await
    .is_err());
    assert_eq!(
        git::discover(&temp.path().join("repo"), "main")
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn failed_handoff_persistence_never_starts_the_next_agent() {
    let (_temp, db, unit) = setup().await;
    let uid = unit["id"].as_str().unwrap();
    let executor = Executor::new(db.clone());
    let planner = executor.next(uid).await.unwrap();
    assert_eq!(
        wait(&db, planner["agent_id"].as_str().unwrap()).await["status"],
        "completed"
    );
    executor.shutdown().await;
    db.execute("CREATE TRIGGER reject_handoff BEFORE INSERT ON handoffs BEGIN SELECT RAISE(ABORT,'simulated handoff failure'); END", vec![]).await.unwrap();
    assert!(executor
        .next(uid)
        .await
        .unwrap_err()
        .to_string()
        .contains("simulated handoff failure"));
    let team = work::team(&db, uid).await.unwrap();
    let builder = team.iter().find(|a| a["role"] == "builder").unwrap();
    assert_eq!(builder["status"], "idle");
    assert!(builder["provider_session_id"].is_null());
    assert_eq!(
        db.one("SELECT count(*) AS n FROM provider_sessions", vec![])
            .await
            .unwrap()["n"],
        1
    );
    executor.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn real_process_adapter_uses_explicit_sandbox_and_captures_jsonl() {
    use std::os::unix::fs::PermissionsExt;
    let (temp, db, unit) = setup().await;
    let cli = temp.path().join("codex-contract-fixture");
    std::fs::write(&cli,r#"#!/bin/sh
case "$*" in
  --version) printf 'codex synthetic contract fixture\n'; exit 0;;
  'exec --help') printf 'exec --sandbox --model --json --ephemeral --color\n'; exit 0;;
esac
case "$*" in *'--sandbox read-only'*) ;; *) exit 91;; esac
case "$*" in *danger*) exit 92;; esac
cat >/dev/null
printf '%s\n' '{"type":"thread.started","thread_id":"synthetic-native-process"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"command_execution","command":"cargo test","exit_code":0,"aggregated_output":"synthetic command output"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Native process contract test completed"}}'
printf '%s\n' '{"type":"turn.completed"}'
"#).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let previous = std::env::var_os("OTTER_CODEX_BIN");
    std::env::set_var("OTTER_CODEX_BIN", &cli);
    let team = work::team(&db, unit["id"].as_str().unwrap()).await.unwrap();
    let planner = &team[0];
    db.execute(
        "UPDATE agent_profiles SET provider='codex',model=NULL WHERE id=?",
        vec![planner["profile_id"].clone()],
    )
    .await
    .unwrap();
    let executor = Executor::new(db.clone());
    let run = executor
        .start(
            planner["id"].as_str().unwrap(),
            "Contract test, no provider API call".into(),
        )
        .await
        .unwrap();
    let agent = wait(&db, planner["id"].as_str().unwrap()).await;
    executor.shutdown().await;
    match previous {
        Some(value) => std::env::set_var("OTTER_CODEX_BIN", value),
        None => std::env::remove_var("OTTER_CODEX_BIN"),
    }
    assert_eq!(agent["status"], "completed", "{agent}");
    assert_eq!(agent["result"], "Native process contract test completed");
    let events = db
        .rows(
            "SELECT kind,detail_json FROM normalized_events WHERE session_id=?",
            vec![run["session_id"].clone()],
        )
        .await
        .unwrap();
    assert!(events
        .iter()
        .any(|e| e["kind"] == "tool.shell" && e["detail_json"]["exit_code"] == 0));
}
