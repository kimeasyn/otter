use otter_core::{db::Db, git};
use serde_json::json;
use std::path::Path;

async fn repo(path: &Path) {
    git::run(path, &["init", "-b", "main"]).await.unwrap();
    git::run(path, &["config", "user.name", "Otter Test"])
        .await
        .unwrap();
    git::run(
        path,
        &["config", "user.email", "otter-test@example.invalid"],
    )
    .await
    .unwrap();
    std::fs::write(path.join("shared.txt"), "base\n").unwrap();
    git::run(path, &["add", "shared.txt"]).await.unwrap();
    git::run(path, &["commit", "-m", "baseline"]).await.unwrap();
}

#[tokio::test]
async fn discovers_real_divergence_dirty_files_and_worktrees() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    repo(&root).await;
    let feature = tmp.path().join("feature space");
    git::create_worktree(&root, &feature, "feat/test", "main")
        .await
        .unwrap();
    std::fs::write(feature.join("feature.txt"), "feature").unwrap();
    git::run(&feature, &["add", "."]).await.unwrap();
    git::run(&feature, &["commit", "-m", "feature"])
        .await
        .unwrap();
    std::fs::write(root.join("base.txt"), "base advancement").unwrap();
    git::run(&root, &["add", "."]).await.unwrap();
    git::run(&root, &["commit", "-m", "advance main"])
        .await
        .unwrap();
    std::fs::write(feature.join("space name.txt"), "untracked").unwrap();
    let trees = git::discover(&root, "main").await.unwrap();
    assert_eq!(trees.len(), 2);
    let f = trees
        .iter()
        .find(|s| s.branch.as_deref() == Some("feat/test"))
        .unwrap();
    assert_eq!((f.ahead, f.behind), (Some(1), Some(1)));
    assert!(f.dirty);
    assert_eq!(f.changed_files, vec!["feature.txt", "space name.txt"]);
    assert!(f.base_commit.is_some());
    assert_eq!(f.head.len(), 40);
    assert!(
        git::create_worktree(&root, &feature, "feat/collision", "main")
            .await
            .is_err()
    );
    assert!(
        git::create_worktree(&root, &tmp.path().join("other"), "feat/test", "main")
            .await
            .is_err()
    );
    assert!(
        git::create_worktree(&root, &tmp.path().join("bad"), "--bad", "main")
            .await
            .is_err()
    );
    assert_eq!(git::root(&feature).await.unwrap(), feature);
}

#[tokio::test]
async fn database_persists_searches_and_reconciles_after_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("test.db");
    let db = Db::open(&path).await.unwrap();
    db.execute(
        "INSERT INTO projects(id,name,root_path,base_branch,created_at,updated_at) VALUES('p','Project','/synthetic','main','now','now')",
        vec![],
    )
    .await
    .unwrap();
    db.execute("INSERT INTO work_units(id,project_id,title,description,base_branch,base_commit,branch,worktree_path,created_at) VALUES('w','p','Canonicalization','Gene synonym normalization','main','abc','feat/test','/synthetic/work','now')",vec![]).await.unwrap();
    db.execute("INSERT INTO agent_profiles VALUES('profile','Builder','fake',NULL,'builder','','advisory','now')",vec![]).await.unwrap();
    db.execute("INSERT INTO agent_instances(id,work_unit_id,profile_id,name,status,pid) VALUES('agent','w','profile','Builder','running',123456)",vec![]).await.unwrap();
    db.0.close().await;
    let db = Db::open(&path).await.unwrap();
    db.reconcile().await.unwrap();
    let rows = db
        .rows(
            "SELECT * FROM search_index WHERE search_index MATCH ?",
            vec![json!("synonym")],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["work_unit_id"], "w");
    let agent = db
        .one("SELECT * FROM agent_instances", vec![])
        .await
        .unwrap();
    assert_eq!(agent["status"], "interrupted");
    assert!(agent["pid"].is_null());
    assert!(db
        .execute(
            "INSERT INTO projects(id,name,root_path,base_branch,created_at,updated_at) VALUES('p2','Other','/synthetic','main','now','now')",
            vec![]
        )
        .await
        .is_err());
}

#[tokio::test]
async fn refuses_unrelated_sqlite_without_changing_its_contents() {
    use sqlx::Connection;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("unrelated.db");
    let mut connection = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE unrelated(value TEXT)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO unrelated VALUES('preserve this')")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Db::open(&path).await.is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[tokio::test]
async fn paginated_history_and_fts_at_beta_event_volume() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("scale.db")).await.unwrap();
    db.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO provider_sessions(id,provider,external_session_id,title,started_at,last_seen_at,status) SELECT 's'||x,'fake','synthetic'||x,'Synthetic session '||x,'now','now','completed' FROM n", vec![]).await.unwrap();
    db.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000) INSERT INTO normalized_events(session_id,timestamp,kind,text,target) SELECT 's'||(1+(x%1000)),'now','assistant.message','Synthetic event '||x||CASE WHEN x=199999 THEN ' riverneedle' ELSE '' END,'src/example.rs' FROM n", vec![]).await.unwrap();
    let started = std::time::Instant::now();
    let page = db.rows("SELECT id,kind,text FROM normalized_events WHERE session_id='s1000' ORDER BY id LIMIT 100 OFFSET 100", vec![]).await.unwrap();
    assert_eq!(page.len(), 100);
    let found = db
        .rows(
            "SELECT session_id FROM search_index WHERE search_index MATCH 'riverneedle' LIMIT 100",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["session_id"], "s1000");
    assert_eq!(
        db.one("SELECT count(*) AS n FROM normalized_events", vec![])
            .await
            .unwrap()["n"],
        200000
    );
    eprintln!(
        "1000-session / 200000-event page + FTS + count checks: {:?}",
        started.elapsed()
    );
}
