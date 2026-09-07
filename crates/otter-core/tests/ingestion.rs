use otter_core::{
    db::Db,
    ingestion,
    providers::{Claude, Codex, ProviderAdapter},
};
use serde_json::json;
use std::io::Write;

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
