use crate::{ApiError, AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    response::Response,
};
use otter_core::{id, now};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};

#[derive(Deserialize)]
pub struct Target {
    project_id: String,
    worktree_id: Option<String>,
    work_unit_id: Option<String>,
}

pub async fn upgrade(
    State(s): State<AppState>,
    Query(target): Query<Target>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let project =
        s.db.one(
            "SELECT root_path FROM projects WHERE id=?",
            vec![target.project_id.clone().into()],
        )
        .await?;
    let (cwd, uid) = if let Some(uid) = target.work_unit_id {
        let unit =
            s.db.one(
                "SELECT worktree_path FROM work_units WHERE id=? AND project_id=?",
                vec![uid.clone().into(), target.project_id.into()],
            )
            .await?;
        (
            unit["worktree_path"].as_str().unwrap_or("").to_string(),
            Some(uid),
        )
    } else if let Some(tid) = target.worktree_id {
        let tree =
            s.db.one(
                "SELECT path,work_unit_id FROM worktrees WHERE id=? AND project_id=?",
                vec![tid.into(), target.project_id.into()],
            )
            .await?;
        (
            tree["path"].as_str().unwrap_or("").to_string(),
            tree["work_unit_id"].as_str().map(str::to_owned),
        )
    } else {
        (
            project["root_path"].as_str().unwrap_or("").to_string(),
            None,
        )
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(anyhow::anyhow!("Terminal directory is unavailable").into());
    }
    Ok(ws
        .protocols(["otter"])
        .max_message_size(65536)
        .on_upgrade(move |socket| async move {
            if let Err(error) = session(s, socket, cwd, uid).await {
                tracing::warn!(error=%error,"Otter terminal ended with an error");
            }
        }))
}

async fn session(
    s: AppState,
    mut socket: WebSocket,
    cwd: String,
    uid: Option<String>,
) -> anyhow::Result<()> {
    let setup = (|| {
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/bash".into()
            }
        }));
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("OTTER_TERMINAL", "1");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        Ok::<_, anyhow::Error>((pair.master, child))
    })();
    let (master, mut child) = match setup {
        Ok(result) => result,
        Err(error) => {
            let _ = socket
                .send(Message::Text(
                    format!("\r\nCannot start terminal: {error}\r\n").into(),
                ))
                .await;
            return Ok(());
        }
    };
    let pid = child.process_id();
    let process = id();
    let mut killer = child.clone_killer();
    let db_result=s.db.execute("INSERT INTO processes(id,work_unit_id,kind,cwd,pid,status,started_at) VALUES(?,?,'terminal',?,?,'running',?)",vec![process.clone().into(),json!(uid),cwd.into(),json!(pid),now().into()]).await;
    if let Err(error) = db_result {
        let _ = killer.kill();
        return Err(error);
    }
    let mut reader = master.try_clone_reader()?;
    let mut writer = master.take_writer()?;
    let master = std::sync::Mutex::new(master);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let reading = tokio::task::spawn_blocking(move || {
        let mut buffer = [0; 8192];
        while let Ok(n) = reader.read(&mut buffer) {
            if n == 0 || tx.blocking_send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut ending = s.terminal_shutdown.subscribe();
    let active=async {
        loop {
            tokio::select! {
                _=ending.changed()=>break,
                output=rx.recv()=>match output {Some(bytes)=>socket.send(Message::Binary(bytes.into())).await?,None=>break},
                message=socket.recv()=>match message {
                    Some(Ok(Message::Text(text)))=>{
                        let value:Value=serde_json::from_str(&text)?;
                        match value["type"].as_str() {
                            Some("input")=>{if let Some(data)=value["data"].as_str(){writer.write_all(data.as_bytes())?;writer.flush()?;}},
                            Some("resize")=>{master.lock().map_err(|_|anyhow::anyhow!("Terminal resize lock failed"))?.resize(PtySize{rows:value["rows"].as_u64().unwrap_or(24).clamp(2,200) as u16,cols:value["cols"].as_u64().unwrap_or(100).clamp(10,500) as u16,pixel_width:0,pixel_height:0})?;},
                            _=>{}
                        }
                    },
                    Some(Ok(Message::Ping(bytes)))=>socket.send(Message::Pong(bytes)).await?,
                    Some(Ok(Message::Close(_)))|None=>break,
                    Some(Err(error))=>return Err(anyhow::Error::from(error)),
                    _=>{}
                }
            }
        }
        Ok::<(),anyhow::Error>(())
    }.await;
    let _ = killer.kill();
    drop(writer);
    drop(master);
    drop(rx);
    let exit = tokio::task::spawn_blocking(move || child.wait()).await?;
    let _ = reading.await;
    s.db.execute(
        "UPDATE processes SET status='stopped',pid=NULL,ended_at=?,exit_code=? WHERE id=?",
        vec![
            now().into(),
            json!(exit.ok().map(|e| e.exit_code())),
            process.into(),
        ],
    )
    .await?;
    let _ = socket.send(Message::Close(None)).await;
    active
}
