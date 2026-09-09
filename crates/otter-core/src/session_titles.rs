//! Local, deterministic session titles. Provider names take priority over excerpts;
//! no conversation is sent to a model or written back to the provider's files.
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::Path,
};

const TITLE_LENGTH: usize = 48;

pub fn compact(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= TITLE_LENGTH {
        return Some(text);
    }
    let prefix: String = text.chars().take(TITLE_LENGTH - 1).collect();
    // Prefer a complete word, but still handle Korean and unbroken identifiers.
    let prefix = prefix
        .rfind(' ')
        .filter(|&i| prefix[..i].chars().count() >= TITLE_LENGTH / 2)
        .map(|i| &prefix[..i])
        .unwrap_or(&prefix);
    Some(format!("{}…", prefix.trim_end()))
}

pub fn from_message(text: &str) -> Option<String> {
    if text.trim_start().starts_with("# AGENTS.md instructions") {
        return None;
    }
    let mut text = text.to_owned();
    // These are context supplied by the client, not the user's task.
    for tag in [
        "environment_context",
        "environment_details",
        "INSTRUCTIONS",
        "permissions instructions",
        "turn_aborted",
    ] {
        let opening = format!("<{tag}>");
        let closing = format!("</{tag}>");
        while let Some(start) = text.find(&opening) {
            let end = text[start..]
                .find(&closing)
                .map(|end| start + end + closing.len())
                .unwrap_or(text.len());
            text.replace_range(start..end, "\n");
        }
    }
    if let Some((_, request)) = text.split_once("# My request for Codex:") {
        text = request.to_owned();
    } else if text
        .trim_start()
        .starts_with("# Context from my IDE setup:")
    {
        return None;
    }
    let mut in_code = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code || line.is_empty() || line.starts_with('<') {
            continue;
        }
        let line = line.trim_start_matches(['#', '>', '-', '*', ' ']);
        let line = line
            .strip_prefix("Please ")
            .or_else(|| line.strip_prefix("please "))
            .unwrap_or(line);
        let end = [". ", "? ", "! "]
            .iter()
            .filter_map(|stop| line.find(stop))
            .min()
            .unwrap_or(line.len());
        if let Some(title) = compact(line[..end].trim_matches(['`', '*', ' '])) {
            return Some(title);
        }
    }
    None
}

/// The append-only Codex name index lives next to sessions/archived_sessions.
/// Resolve it from the imported file, including non-default CODEX_HOME locations.
pub fn codex_name(path: &Path, external_id: &str) -> Option<String> {
    let root = path
        .ancestors()
        .find(|parent| {
            matches!(
                parent.file_name().and_then(|s| s.to_str()),
                Some("sessions" | "archived_sessions")
            )
        })?
        .parent()?;
    let file = std::fs::File::open(root.join("session_index.jsonl")).ok()?;
    // Optional metadata must never prevent importing the actual conversation.
    if file.metadata().ok()?.len() > 16 * 1024 * 1024 {
        return None;
    }
    let mut name = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record["id"].as_str() == Some(external_id) {
            if let Some(title) = record["thread_name"].as_str().and_then(compact) {
                name = Some(title);
            }
        }
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_task_without_client_context_or_code() {
        assert_eq!(
            from_message("# AGENTS.md instructions for /repo\n<INSTRUCTIONS>rules</INSTRUCTIONS>"),
            None
        );
        assert_eq!(
            from_message("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"),
            None
        );
        assert_eq!(from_message("<environment_context>metadata</environment_context>\nPlease fix parser boundaries. Keep existing tests."), Some("fix parser boundaries".into()));
        assert_eq!(from_message("# Context from my IDE setup:\n## Open tabs:\n- app.ts\n# My request for Codex:\n세션 제목 표시 개선"), Some("세션 제목 표시 개선".into()));
        assert_eq!(
            from_message("```rust\nfn main() {}\n```\nExplain the parser"),
            Some("Explain the parser".into())
        );
    }

    #[test]
    fn titles_are_short_unicode_safe_and_keep_short_names() {
        assert_eq!(
            compact("  세션 제목\n  개선  "),
            Some("세션 제목 개선".into())
        );
        let title = compact(&"가".repeat(100)).unwrap();
        assert_eq!(title.chars().count(), TITLE_LENGTH);
        assert!(title.ends_with('…'));
        assert_eq!(compact(" \n "), None);
    }
}
