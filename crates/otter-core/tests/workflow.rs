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
        "INSERT INTO projects VALUES('p','Test',?,'main','now','now')",
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
