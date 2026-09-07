use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub kind: String,
    pub text: String,
    pub target: Option<String>,
    pub detail: Value,
}
impl Event {
    fn new(kind: &str, text: impl Into<String>, target: Option<String>, detail: Value) -> Self {
        Self {
            kind: kind.into(),
            text: text.into(),
            target,
            detail,
        }
    }
}

pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn normalize(&self, raw: &Value) -> Vec<Event>;
}
pub struct Codex;
pub struct Claude;
pub struct Fake;

fn content_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.into();
    }
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn tool(name: &str, args: &Value, raw: &Value) -> Event {
    let lower = name.to_lowercase();
    let target = args["file_path"]
        .as_str()
        .or(args["path"].as_str())
        .map(str::to_owned);
    let command = args["command"].as_str().or(args["cmd"].as_str());
    let kind = if command.is_some()
        || matches!(
            lower.as_str(),
            "bash" | "shell" | "exec_command" | "shell_command"
        ) {
        "tool.shell"
    } else if matches!(lower.as_str(), "read" | "read_file") {
        "tool.file_read"
    } else if matches!(
        lower.as_str(),
        "write" | "edit" | "apply_patch" | "write_file" | "multiedit"
    ) {
        "tool.file_write"
    } else if matches!(lower.as_str(), "grep" | "glob" | "websearch" | "search") {
        "tool.search"
    } else {
        "tool.other"
    };
    Event::new(
        kind,
        command.unwrap_or(name),
        target,
        json!({"name":name,"arguments":args,"source":raw}),
    )
}

impl ProviderAdapter for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }
    fn normalize(&self, raw: &Value) -> Vec<Event> {
        let outer = raw["type"].as_str().unwrap_or("");
        let p = if outer == "response_item" || outer == "event_msg" {
            &raw["payload"]
        } else {
            raw
        };
        let kind = p["type"].as_str().unwrap_or("");
        let mut events = vec![];
        match (outer, kind) {
            ("session_meta", _) | ("thread.started", _) => events.push(Event::new(
                "session.start",
                "Session started",
                None,
                json!({}),
            )),
            ("response_item", "message") => {
                if let Some(role @ ("user" | "assistant")) = p["role"].as_str() {
                    let text = content_text(&p["content"]);
                    if !text.is_empty() {
                        events.push(Event::new(
                            &format!("{role}.message"),
                            text,
                            None,
                            json!({}),
                        ));
                    }
                }
            }
            ("response_item", "reasoning") => {
                // Only explicit public summary content; never encrypted reasoning.
                let summary = content_text(&p["summary"]);
                if !summary.is_empty() {
                    events.push(Event::new(
                        "assistant.reasoning_summary",
                        summary,
                        None,
                        json!({}),
                    ));
                }
            }
            ("response_item", "function_call" | "custom_tool_call") => {
                let args = if let Some(s) = p["arguments"].as_str() {
                    serde_json::from_str(s).unwrap_or(json!({"input":s}))
                } else {
                    json!({"input":p["input"]})
                };
                events.push(tool(p["name"].as_str().unwrap_or("unknown"), &args, p));
            }
            ("response_item", "function_call_output" | "custom_tool_call_output") => events.push(
                Event::new("tool.result", content_text(&p["output"]), None, p.clone()),
            ),
            ("event_msg", "task_started") => events.push(Event::new(
                "session.resume",
                "Turn started",
                None,
                json!({}),
            )),
            ("event_msg", "task_complete") | ("turn.completed", _) => {
                events.push(Event::new("session.end", "Turn completed", None, p.clone()))
            }
            ("compacted", _) | ("event_msg", "context_compacted") => events.push(Event::new(
                "system.compaction",
                "Context compacted",
                None,
                json!({}),
            )),
            ("item.completed", _) => {
                let item = &raw["item"];
                match item["type"].as_str().unwrap_or("") {
                    "agent_message" => events.push(Event::new(
                        "assistant.message",
                        item["text"].as_str().unwrap_or(""),
                        None,
                        json!({}),
                    )),
                    "reasoning" => events.push(Event::new(
                        "assistant.reasoning_summary",
                        item["text"].as_str().unwrap_or(""),
                        None,
                        json!({}),
                    )),
                    "command_execution" => events.push(Event::new(
                        "tool.shell",
                        item["command"].as_str().unwrap_or(""),
                        None,
                        item.clone(),
                    )),
                    "file_change" => {
                        if let Some(changes) = item["changes"].as_array() {
                            for c in changes {
                                events.push(Event::new(
                                    "tool.file_write",
                                    c["kind"].as_str().unwrap_or("changed"),
                                    c["path"].as_str().map(str::to_owned),
                                    c.clone(),
                                ));
                            }
                        }
                    }
                    "web_search" => events.push(Event::new(
                        "tool.search",
                        item["query"].as_str().unwrap_or("Search"),
                        None,
                        item.clone(),
                    )),
                    _ => {}
                }
            }
            ("turn.failed" | "error", _) => events.push(Event::new(
                "session.error",
                p["message"]
                    .as_str()
                    .or(p["error"]["message"].as_str())
                    .unwrap_or("Provider error"),
                None,
                p.clone(),
            )),
            _ => {}
        }
        events
    }
}

impl ProviderAdapter for Claude {
    fn name(&self) -> &'static str {
        "claude"
    }
    fn normalize(&self, raw: &Value) -> Vec<Event> {
        let mut events = vec![];
        let role = raw["type"].as_str().unwrap_or("");
        if matches!(role, "user" | "assistant") {
            let content = &raw["message"]["content"];
            let text = content_text(content);
            if !text.is_empty() {
                events.push(Event::new(
                    &format!("{role}.message"),
                    text,
                    None,
                    json!({}),
                ));
            }
            if let Some(blocks) = content.as_array() {
                for block in blocks {
                    match block["type"].as_str().unwrap_or("") {
                        "tool_use" => events.push(tool(
                            block["name"].as_str().unwrap_or("unknown"),
                            &block["input"],
                            block,
                        )),
                        "tool_result" => events.push(Event::new(
                            "tool.result",
                            content_text(&block["content"]),
                            None,
                            block.clone(),
                        )),
                        // Do not promote provider thinking blocks to public summaries.
                        _ => {}
                    }
                }
            }
        } else if role == "system" && raw["subtype"] == "compact_boundary" {
            events.push(Event::new(
                "system.compaction",
                "Context compacted",
                None,
                json!({}),
            ));
        } else if role == "result" {
            events.push(Event::new(
                if raw["is_error"] == true {
                    "session.error"
                } else {
                    "assistant.message"
                },
                raw["result"].as_str().unwrap_or("Provider completed"),
                None,
                raw.clone(),
            ));
        }
        events
    }
}

impl ProviderAdapter for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn normalize(&self, raw: &Value) -> Vec<Event> {
        serde_json::from_value(raw.clone())
            .map(|e| vec![e])
            .unwrap_or_default()
    }
}

pub fn adapter(name: &str) -> anyhow::Result<Box<dyn ProviderAdapter>> {
    match name {
        "codex" => Ok(Box::new(Codex)),
        "claude" => Ok(Box::new(Claude)),
        "fake" => Ok(Box::new(Fake)),
        _ => anyhow::bail!("Unknown provider: {name}"),
    }
}

pub fn session_roots(name: &str) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    match name {
        "codex" => {
            if let Some(p) = std::env::var_os("OTTER_CODEX_SESSIONS") {
                return vec![p.into()];
            }
            let root = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            vec![root.join("sessions"), root.join("archived_sessions")]
        }
        "claude" => vec![std::env::var_os("OTTER_CLAUDE_SESSIONS")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude/projects"))],
        _ => vec![],
    }
}

pub fn executable(name: &str) -> String {
    let key = match name {
        "codex" => "OTTER_CODEX_BIN",
        "claude" => "OTTER_CLAUDE_BIN",
        _ => "OTTER_FAKE_BIN",
    };
    std::env::var(key).unwrap_or_else(|_| name.into())
}

pub async fn detect(name: &str) -> Value {
    if name == "fake" {
        return json!({"id":"fake","name":"FakeProvider","available":true,"version":"Otter synthetic provider 1","synthetic":true,"models":["deterministic"],"capabilities":{"discovery":false,"one_shot":true,"resume":false,"model_selection":false,"permission_enforcement":false,"interactive":false},"note":"Simulated activity only; no LLM calls or real code changes."});
    }
    let bin = executable(name);
    let version = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&bin)
            .arg("--version")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let version = version
        .ok()
        .and_then(Result::ok)
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
    let help = if version.is_some() {
        tokio::time::timeout(
            Duration::from_secs(5),
            Command::new(&bin).arg("--help").kill_on_drop(true).output(),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
    } else {
        String::new()
    };
    let one_shot = if name == "codex" {
        help.contains("exec")
    } else {
        help.contains("--print") && help.contains("--output-format")
    };
    json!({"id":name,"name":if name=="codex" {"Codex"}else{"Claude Code"},"available":version.is_some(),"version":version,"synthetic":false,
        "models":[],"executable":bin,"session_roots":session_roots(name),
        "capabilities":{"discovery":true,"one_shot":one_shot,"resume":false,"model_selection":help.contains("--model"),"permission_enforcement":name=="codex"&&help.contains("--sandbox"),"interactive":false},
        "note":if version.is_none(){"CLI not detected. Session files can still be imported."}else{"Model availability depends on your provider account. Native session resume is not enabled in this beta adapter."}})
}
