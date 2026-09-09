use otter_core::{
    db::Db,
    ingestion,
    providers::{Claude, Codex, ProviderAdapter},
};
use serde_json::json;
use std::io::Write;

#[tokio::test]
async fn session_titles_use_provider_names_and_refresh_without_new_messages() {
    let temp = tempfile::tempdir().unwrap();
    let sessions = temp.path().join("sessions/2026/09/09");
    std::fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("session.jsonl");
    let fixture = include_str!("../../../fixtures/codex/history.jsonl");
    std::fs::write(&path, fixture).unwrap();
    let index = temp.path().join("session_index.jsonl");
    let names = concat!(
        "{\"id\":\"synthetic-codex-history\",\"thread_name\":\"Old name\"}\n",
        "not valid JSON\n",
        "{\"id\":\"another-session\",\"thread_name\":\"Unrelated name\"}\n",
        "{\"id\":\"synthetic-codex-history\",\"thread_name\":\"파서 경계 처리 개선\"}\n",
        "{\"id\":\"synthetic-codex-history\",\"thread_name\":\"  \"}\n",
    );
    std::fs::write(&index, names).unwrap();
    let db = Db::open(&temp.path().join("otter.db")).await.unwrap();
    ingestion::ingest(&db, "codex", &path).await.unwrap();
    assert_eq!(
        db.one("SELECT title FROM provider_sessions", vec![])
            .await
            .unwrap()["title"],
        "파서 경계 처리 개선"
    );
    assert_eq!(std::fs::read_to_string(&index).unwrap(), names);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&index)
        .unwrap();
    writeln!(
        file,
        "{}",
        json!({"id":"synthetic-codex-history", "thread_name":"부분 레코드 파싱 수정"})
    )
    .unwrap();
    let again = ingestion::ingest(&db, "codex", &path).await.unwrap();
    assert_eq!(again["inserted"], 0);
    assert_eq!(
        db.one("SELECT title FROM provider_sessions", vec![])
            .await
            .unwrap()["title"],
        "부분 레코드 파싱 수정"
    );
    assert_eq!(
        db.one(
            "SELECT count(*) AS n FROM search_index WHERE search_index MATCH '부분'",
            vec![]
        )
        .await
        .unwrap()["n"],
        1
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), fixture);
}

#[tokio::test]
async fn existing_titles_skip_scaffolding_and_use_the_actual_request() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("session.jsonl");
    let records = [
        json!({"type":"session_meta", "payload":{"id":"context-session", "cwd":"/repo"}}),
        json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"# AGENTS.md instructions for /repo\n<INSTRUCTIONS>rules</INSTRUCTIONS>"}]}}),
        json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"}]}}),
        json!({"type":"response_item", "payload":{"type":"message", "role":"user", "content":[{"type":"input_text", "text":"세션 제목 표시 개선\n목록과 상세 화면에 반영해줘"}]}}),
    ];
    std::fs::write(
        &path,
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let db = Db::open(&temp.path().join("otter.db")).await.unwrap();
    ingestion::ingest(&db, "codex", &path).await.unwrap();
    db.execute(
        "UPDATE provider_sessions SET title='Legacy context title'",
        vec![],
    )
    .await
    .unwrap();
    assert_eq!(
        ingestion::ingest(&db, "codex", &path).await.unwrap()["inserted"],
        0
    );
    assert_eq!(
        db.one("SELECT title FROM provider_sessions", vec![])
            .await
            .unwrap()["title"],
        "세션 제목 표시 개선"
    );
}

#[tokio::test]
async fn imports_fixtures_incrementally_without_duplicates_and_survives_truncation() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("db.sqlite");
    let db = Db::open(&db_path).await.unwrap();
    for (provider, fixture, count) in [
        (
            "codex",
            include_str!("../../../fixtures/codex/history.jsonl"),
            9,
        ),
        (
            "claude",
            include_str!("../../../fixtures/claude/history.jsonl"),
            7,
        ),
    ] {
        let path = temp.path().join(format!("{provider}.jsonl"));
        std::fs::write(&path, fixture).unwrap();
        let first = ingestion::ingest(&db, provider, &path).await.unwrap();
        assert_eq!(first["inserted"], count);
        let again = ingestion::ingest(&db, provider, &path).await.unwrap();
        assert_eq!(again["inserted"], 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), fixture);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(file, "{{\"type\":\"future_partial\"").unwrap();
        let partial = ingestion::ingest(&db, provider, &path).await.unwrap();
        assert_eq!(partial["inserted"], 0);
        writeln!(file, "}}").unwrap();
        assert_eq!(
            ingestion::ingest(&db, provider, &path).await.unwrap()["inserted"],
            1
        );
        std::fs::write(&path, fixture).unwrap();
        let truncated = ingestion::ingest(&db, provider, &path).await.unwrap();
        assert_eq!(truncated["inserted"], 0);
        assert_eq!(truncated["reset"], true);
    }
    let search = db
        .rows(
            "SELECT * FROM search_index WHERE search_index MATCH 'river'",
            vec![],
        )
        .await
        .unwrap();
    assert!(search.len() >= 3);
    let raw_count = db
        .one("SELECT count(*) AS n FROM raw_events", vec![])
        .await
        .unwrap();
    db.0.close().await;
    let db = Db::open(&db_path).await.unwrap();
    assert_eq!(
        db.one("SELECT count(*) AS n FROM raw_events", vec![])
            .await
            .unwrap(),
        raw_count
    );
    assert_eq!(
        ingestion::ingest(&db, "codex", &temp.path().join("codex.jsonl"))
            .await
            .unwrap()["inserted"],
        0
    );
}

#[test]
fn summaries_and_tools_do_not_leak_into_conversation() {
    let codex=Codex.normalize(&json!({"type":"response_item","payload":{"type":"reasoning","encrypted_content":"opaque","summary":[]}}));
    assert!(codex.is_empty());
    let claude=Claude.normalize(&json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"not a public summary"},{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}]}}));
    assert_eq!(claude.len(), 1);
    assert_eq!(claude[0].kind, "tool.shell");
    assert!(Codex
        .normalize(&json!({"type":"future-unknown"}))
        .is_empty());
}
