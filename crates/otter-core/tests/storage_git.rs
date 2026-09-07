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
        "INSERT INTO projects VALUES('p','Project','/synthetic','main','now','now')",
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
            "INSERT INTO projects VALUES('p2','Other','/synthetic','main','now','now')",
            vec![]
        )
        .await
        .is_err());
}
