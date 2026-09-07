use anyhow::{bail, Context, Result};
use fs2::FileExt;
use otter_core::db::Db;
use otterd::{router, AppState};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("otterd=info,otter_core=info")
        .init();
    let data = std::env::var_os("OTTER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            directories::ProjectDirs::from("dev", "Otter", "Otter")
                .expect("application data directory")
                .data_local_dir()
                .to_path_buf()
        });
    fs::create_dir_all(&data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data.join("daemon.lock"))?;
    lock.try_lock_exclusive()
        .context("Another Otter daemon is already using this data directory")?;
    let address: SocketAddr = std::env::var("OTTER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:4317".into())
        .parse()?;
    if !address.ip().is_loopback() {
        bail!("Otter beta requires a loopback address; use SSH forwarding for home-server access");
    }
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .context("Otter port is unavailable; set OTTER_BIND to another localhost port")?;
    let address = listener.local_addr()?;
    let db = Db::open(&data.join("otter.db")).await?;
    db.reconcile().await?;
    let token = format!("{}{}", otter_core::id(), otter_core::id());
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut connection = options.open(data.join("connection.json"))?;
    connection.write_all(serde_json::to_string(&serde_json::json!({"url":format!("http://{address}"),"token":token,"pid":std::process::id()}))?.as_bytes())?;
    let state = AppState {
        db,
        token: Arc::new(token),
    };
    let web = std::env::var_os("OTTER_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("apps/web/dist"));
    tracing::info!(%address,"Otter daemon started; authentication details are in the private data directory");
    axum::serve(listener, router(state, web))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    fs::remove_file(data.join("connection.json"))?;
    Ok(())
}
