use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use otter_core::db::Db;
use otterd::{router, AppState};
use tower::ServiceExt;

#[tokio::test]
async fn directory_browser_requires_auth_and_lists_only_folders() {
    use http_body_util::BodyExt;
    use otter_core::git;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("folders");
    std::fs::create_dir(&root).unwrap();
    for name in ["repo space", ".hidden", "일반 폴더"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    std::fs::write(root.join("private.txt"), "never returned").unwrap();
    git::run(&root.join("repo space"), &["init", "-b", "main"])
        .await
        .unwrap();
    let db = Db::open(&temp.path().join("test.db")).await.unwrap();
    let app = router(AppState::new(db, "token".into()), temp.path().into());
    for (suffix, token, expected) in [
        ("", "", StatusCode::UNAUTHORIZED),
        ("", "Bearer token", StatusCode::OK),
        ("&hidden=true", "Bearer token", StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/directories?path={}{}",
                        root.display(),
                        suffix
                    ))
                    .header("host", "localhost:4317")
                    .header("authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            let data: serde_json::Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            let entries = data["entries"].as_array().unwrap();
            assert_eq!(entries.len(), if suffix.is_empty() { 2 } else { 3 });
            assert!(entries.iter().all(|e| e["name"] != "private.txt"));
            assert!(entries
                .iter()
                .any(|e| e["name"] == "repo space" && e["is_git"] == true));
            assert!(data["git_root"].is_null());
        }
    }
    for (path, expected) in [
        ("repo%20space", StatusCode::OK),
        ("absent", StatusCode::BAD_REQUEST),
        ("private.txt", StatusCode::BAD_REQUEST),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/directories?path={}/{path}", root.display()))
                    .header("host", "localhost:4317")
                    .header("authorization", "Bearer token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            let data: serde_json::Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(
                data["git_root"],
                root.join("repo space").to_string_lossy().as_ref()
            );
            assert_eq!(data["parent"], root.to_string_lossy().as_ref());
        }
    }
}

#[tokio::test]
async fn project_rescan_uses_unit_base_and_associates_only_proven_history_links() {
    use otter_core::{git, work};
    use serde_json::json;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git::run(&repo, &["init", "-b", "main"]).await.unwrap();
    std::fs::write(repo.join("base.txt"), "base").unwrap();
    git::run(&repo, &["add", "."]).await.unwrap();
    git::run(
        &repo,
        &[
            "-c",
            "user.name=Otter Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "baseline",
        ],
    )
    .await
    .unwrap();
    git::run(&repo, &["checkout", "-b", "release"])
        .await
        .unwrap();
    std::fs::write(repo.join("release.txt"), "release").unwrap();
    git::run(&repo, &["add", "."]).await.unwrap();
    git::run(
        &repo,
        &[
            "-c",
            "user.name=Otter Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "release",
        ],
    )
    .await
    .unwrap();
    let db = Db::open(&temp.path().join("test.db")).await.unwrap();
    db.execute(
        "INSERT INTO projects VALUES('p','Repo',?,'main','now','now')",
        vec![repo.to_string_lossy().to_string().into()],
    )
    .await
    .unwrap();
    let path = temp.path().join("feature");
    let input = serde_json::from_value(json!({"project_id":"p","title":"Different base","base_branch":"release","branch":"feat/task","worktree_path":path,"team":[{"name":"Planner","provider":"fake","role":"planner","model":null}]})).unwrap();
    work::create(&db, input).await.unwrap();
    db.execute("INSERT INTO provider_sessions(id,provider,external_session_id,title,cwd,started_at,last_seen_at,status) VALUES('old','codex','old','Earlier session',?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z','imported')", vec![path.to_string_lossy().to_string().into()]).await.unwrap();
    let state = AppState::new(db.clone(), "token".into());
    let data = otterd::scan_project(&state, "p").await.unwrap();
    let tree = data["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["path"] == path.to_string_lossy().as_ref())
        .unwrap();
    assert_eq!(tree["base_branch"], "release");
    assert_eq!(tree["ahead"], 0);
    assert_eq!(tree["behind"], 0);
    let old = db
        .one("SELECT * FROM provider_sessions WHERE id='old'", vec![])
        .await
        .unwrap();
    assert_eq!(old["project_id"], "p");
    assert_eq!(old["worktree_id"], tree["id"]);
    assert!(
        old["work_unit_id"].is_null(),
        "cwd alone cannot prove a Work Unit association"
    );
    let stored = db
        .one(
            "SELECT base_branch FROM worktrees WHERE id=?",
            vec![tree["id"].clone()],
        )
        .await
        .unwrap();
    assert_eq!(stored["base_branch"], "release");
}

#[tokio::test]
async fn local_api_requires_token_and_rejects_cross_origin() {
    let tmp = tempfile::tempdir().unwrap();
    let db = Db::open(&tmp.path().join("test.db")).await.unwrap();
    let app = router(AppState::new(db, "test-token".into()), tmp.path().into());
    for (host, token, origin, expected) in [
        ("localhost:4317", "", None, StatusCode::UNAUTHORIZED),
        (
            "localhost:4317",
            "Bearer wrong",
            None,
            StatusCode::UNAUTHORIZED,
        ),
        (
            "evil.example:4317",
            "Bearer test-token",
            None,
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:4317",
            "Bearer test-token",
            Some("https://evil.example"),
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:4317",
            "Bearer test-token",
            Some("http://127.0.0.1:4317"),
            StatusCode::OK,
        ),
    ] {
        let mut req = Request::builder()
            .uri("/api/health")
            .header("host", host)
            .header("authorization", token);
        if let Some(origin) = origin {
            req = req.header("origin", origin);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), expected);
    }
}

#[tokio::test]
async fn merge_state_reports_actual_overlapping_files_without_claiming_conflict() {
    use http_body_util::BodyExt;
    use otter_core::{git, work};
    use serde_json::json;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git::run(&repo, &["init", "-b", "main"]).await.unwrap();
    std::fs::write(repo.join("shared.txt"), "base").unwrap();
    git::run(&repo, &["add", "."]).await.unwrap();
    git::run(
        &repo,
        &[
            "-c",
            "user.name=Otter Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "baseline",
        ],
    )
    .await
    .unwrap();
    let db = Db::open(&temp.path().join("test.db")).await.unwrap();
    db.execute(
        "INSERT INTO projects VALUES('p','Repo',?,'main','now','now')",
        vec![repo.to_string_lossy().to_string().into()],
    )
    .await
    .unwrap();
    let mut units = vec![];
    for name in ["a", "b"] {
        let path = temp.path().join(name);
        let input=serde_json::from_value(json!({"project_id":"p","title":name,"base_branch":"main","branch":format!("feat/{name}"),"worktree_path":path,"team":[{"name":"Planner","provider":"fake","role":"planner","model":null}]})).unwrap();
        units.push(work::create(&db, input).await.unwrap());
        std::fs::write(path.join("shared.txt"), name).unwrap();
    }
    let app = router(AppState::new(db, "token".into()), temp.path().into());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/work-units/{}",
                    units[0]["id"].as_str().unwrap()
                ))
                .header("host", "localhost:4317")
                .header("authorization", "Bearer token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let data: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(data["merge"]["readiness"], "UNCOMMITTED CHANGES");
    assert_eq!(data["merge"]["test"]["status"], "unknown");
    assert_eq!(data["merge"]["overlaps"][0]["files"], json!(["shared.txt"]));
    assert!(data["merge"]["overlaps"][0]["label"]
        .as_str()
        .unwrap()
        .contains("not a confirmed merge conflict"));
}
