use crate::{db::Db, id, now, providers, session_titles};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

fn checksum(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub async fn ingest(db: &Db, provider: &str, path: &Path) -> Result<Value> {
    let adapter = providers::adapter(provider)?;
    let path = path.canonicalize().context("Session file does not exist")?;
    if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        anyhow::bail!("Select a provider JSONL session file");
    }
    let source = path.to_string_lossy().to_string();
    let prior = db
        .rows(
            "SELECT * FROM ingestion_cursors WHERE source_path=?",
            vec![source.clone().into()],
        )
        .await?;
    let prior = prior.first();
    if prior.is_some_and(|p| p["provider"] != provider) {
        anyhow::bail!("This source file was already registered for a different provider");
    }
    let mut file = std::fs::File::open(&path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_else(|_| now());
    let mut offset = prior.and_then(|v| v["byte_offset"].as_u64()).unwrap_or(0);
    let mut sequence = prior.and_then(|v| v["sequence"].as_i64()).unwrap_or(0);
    let prefix = prior.and_then(|v| v["prefix_hash"].as_str()).unwrap_or("");
    let mut reset = size < offset;
    if let Some((len, hash)) = prefix.split_once(':') {
        let len = len.parse::<usize>().unwrap_or(0).min(256);
        let mut bytes = vec![0; len];
        if file.read_exact(&mut bytes).is_err() || checksum(&bytes) != hash {
            reset = true;
        }
    }
    if reset {
        offset = 0;
        sequence = 0;
    }
    file.seek(SeekFrom::Start(0))?;
    let mut first = String::new();
    BufReader::new(&mut file)
        .take(1024 * 1024)
        .read_line(&mut first)?;
    let meta: Value = serde_json::from_str(&first).unwrap_or(Value::Null);
    let external = if provider == "codex" {
        meta["payload"]["id"]
            .as_str()
            .or(meta["payload"]["session_id"].as_str())
            .or(meta["thread_id"].as_str())
    } else {
        meta["sessionId"].as_str()
    }
    .map(str::to_owned)
    .unwrap_or_else(|| checksum(source.as_bytes()));
    let cwd = if provider == "codex" {
        meta["payload"]["cwd"].as_str()
    } else {
        meta["cwd"].as_str()
    };
    let existing = db
        .rows(
            "SELECT id FROM provider_sessions WHERE provider=? AND external_session_id=?",
            vec![provider.into(), external.clone().into()],
        )
        .await?;
    let sid = prior
        .and_then(|v| v["session_id"].as_str())
        .or_else(|| existing.first().and_then(|v| v["id"].as_str()))
        .map(str::to_owned)
        .unwrap_or_else(id);
    let associations = if let Some(cwd) = cwd {
        db.rows(
            "SELECT project_id,id AS worktree_id,work_unit_id FROM worktrees WHERE path=?",
            vec![cwd.into()],
        )
        .await?
    } else {
        vec![]
    };
    let mut assoc = associations.first().cloned().unwrap_or(Value::Null);
    if let Some(uid) = assoc["work_unit_id"].as_str() {
        let unit = db
            .one(
                "SELECT created_at FROM work_units WHERE id=?",
                vec![uid.into()],
            )
            .await?;
        let session_time = meta["timestamp"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        let unit_time = unit["created_at"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok());
        if !matches!((session_time,unit_time),(Some(s),Some(u)) if s>=u) {
            assoc["work_unit_id"] = Value::Null;
        }
    }
    let project = if assoc["project_id"].is_null() {
        if let Some(cwd) = cwd {
            db.rows(
                "SELECT id FROM projects WHERE root_path=?",
                vec![cwd.into()],
            )
            .await?
            .first()
            .map(|v| v["id"].clone())
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        }
    } else {
        assoc["project_id"].clone()
    };
    let stamp = meta["timestamp"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(now);
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = BufReader::new(&mut file);
    let mut batch = Vec::new();
    let mut consumed = 0;
    while batch.len() < 500 && consumed < 8 * 1024 * 1024 {
        let mut line = Vec::new();
        let n = (&mut reader)
            .take(4 * 1024 * 1024)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            if n >= 4 * 1024 * 1024 {
                anyhow::bail!("Session line exceeds 4 MiB; import paused at byte {offset}");
            }
            break; // A provider may still be writing this record. Retry next scan.
        }
        consumed += n;
        offset += n as u64;
        sequence += 1;
        batch.push((sequence, line));
    }
    drop(reader);
    file.seek(SeekFrom::Start(0))?;
    let prefix_len = (offset as usize).min(256);
    let mut bytes = vec![0; prefix_len];
    file.read_exact(&mut bytes)?;
    let fingerprint = format!("{prefix_len}:{}", checksum(&bytes));
    let native_title = if provider == "codex" {
        session_titles::codex_name(&path, &external)
    } else {
        None
    };
    let mut tx = db.0.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO provider_sessions(id,provider,external_session_id,source_path,project_id,worktree_id,work_unit_id,title,cwd,started_at,last_seen_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'imported')")
        .bind(&sid).bind(provider).bind(&external).bind(&source).bind(project.as_str()).bind(assoc["worktree_id"].as_str()).bind(assoc["work_unit_id"].as_str())
        .bind(path.file_stem().unwrap_or_default().to_string_lossy().as_ref()).bind(cwd).bind(&stamp).bind(now()).execute(&mut *tx).await?;
    let mut inserted = 0;
    let mut normalized = 0;
    let mut warnings = 0;
    for (seq, line) in batch {
        let text = String::from_utf8_lossy(&line).trim_end().to_string();
        if text.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(&text);
        let value = parsed.as_ref().ok();
        let timestamp = value
            .and_then(|v| v["timestamp"].as_str())
            .unwrap_or(&stamp);
        let source_type = value
            .and_then(|v| v["type"].as_str())
            .unwrap_or("malformed");
        let raw=sqlx::query("INSERT OR IGNORE INTO raw_events(session_id,source_sequence,timestamp,source_event_type,raw_json,checksum) VALUES(?,?,?,?,?,?) RETURNING id")
            .bind(&sid).bind(seq).bind(timestamp).bind(source_type).bind(&text).bind(checksum(text.as_bytes())).fetch_optional(&mut *tx).await?;
        let Some(raw) = raw else { continue };
        inserted += 1;
        let events = value.map(|v| adapter.normalize(v)).unwrap_or_default();
        if events.is_empty() {
            warnings += 1;
        }
        for event in events {
            sqlx::query("INSERT INTO normalized_events(session_id,raw_event_id,timestamp,kind,text,target,detail_json) VALUES(?,?,?,?,?,?,?)")
                .bind(&sid).bind(raw.get::<i64,_>("id")).bind(timestamp).bind(&event.kind).bind(&event.text).bind(event.target).bind(event.detail.to_string()).execute(&mut *tx).await?;
            normalized += 1;
        }
    }
    // Recompute even when no records were appended: upgrades and provider renames
    // should also fix titles of sessions that were already imported.
    let title = if native_title.is_some() {
        native_title
    } else {
        let messages: Vec<String> = sqlx::query_scalar("SELECT substr(text,1,16000) FROM normalized_events WHERE session_id=? AND kind='user.message' ORDER BY id LIMIT 32")
            .bind(&sid).fetch_all(&mut *tx).await?;
        messages
            .iter()
            .find_map(|text| session_titles::from_message(text))
    };
    let title = title.unwrap_or_else(|| {
        let project = cwd
            .and_then(|cwd| Path::new(cwd).file_name())
            .and_then(|name| name.to_str());
        session_titles::compact(&format!(
            "{} · {}",
            project.unwrap_or(provider),
            "Untitled session"
        ))
        .unwrap()
    });
    sqlx::query(
        "UPDATE provider_sessions SET title=? WHERE id=? AND agent_id IS NULL AND title<>?",
    )
    .bind(&title)
    .bind(&sid)
    .bind(&title)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE provider_sessions SET last_seen_at=?,warning_count=warning_count+? WHERE id=?",
    )
    .bind(modified)
    .bind(warnings)
    .bind(&sid)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO ingestion_cursors(source_path,provider,session_id,byte_offset,sequence,prefix_hash,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_path) DO UPDATE SET byte_offset=excluded.byte_offset,sequence=excluded.sequence,prefix_hash=excluded.prefix_hash,updated_at=excluded.updated_at")
        .bind(&source).bind(provider).bind(&sid).bind(offset as i64).bind(sequence).bind(fingerprint).bind(now()).execute(&mut *tx).await?;
    tx.commit().await?;
    if inserted > 0 {
        tracing::info!(
            provider,
            inserted,
            normalized,
            warnings,
            reset,
            "Otter session batch ingested"
        );
    }
    Ok(
        json!({"session_id":sid,"inserted":inserted,"normalized":normalized,"warnings":warnings,"offset":offset,"size":size,"has_more":offset<size,"reset":reset}),
    )
}

pub fn discover(provider: &str) -> Vec<String> {
    let mut files = vec![];
    for root in providers::session_roots(provider) {
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(root)
            .follow_links(false)
            .max_depth(12)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file()
                && entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
            {
                files.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    files.sort();
    files
}
