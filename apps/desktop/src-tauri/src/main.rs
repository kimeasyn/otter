#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Daemon(Mutex<Option<CommandChild>>);
impl Daemon {
    fn stop(&self) {
        if let Some(child) = self.0.lock().ok().and_then(|mut c| c.take()) {
            #[cfg(unix)]
            {
                // This handle belongs to the sidecar we started, never a saved PID.
                unsafe {
                    libc::kill(child.pid() as i32, libc::SIGINT);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            let _ = child.kill();
        }
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        self.stop();
    }
}

fn main() {
    let app=tauri::Builder::default().plugin(tauri_plugin_shell::init()).setup(|app|{
        let data=app.path().app_data_dir()?;
        let web=if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist")
        }else{app.path().resource_dir()?.join("web")};
        let (mut receiver,child)=app.shell().sidecar("otterd")?
            .env("OTTER_DATA_DIR",&data).env("OTTER_WEB_DIR",web).env("OTTER_BIND","127.0.0.1:0").spawn()?;
        let pid=child.pid();app.manage(Daemon(Mutex::new(Some(child))));
        // Drain pipe events so structured daemon logs cannot block its execution.
        tauri::async_runtime::spawn(async move {while receiver.recv().await.is_some(){}});
        let mut connection=None;
        for _ in 0..100 {
            if let Ok(bytes)=std::fs::read(data.join("connection.json")) {
                if let Ok(value)=serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if value["pid"].as_u64()==Some(pid as u64){connection=Some(value);break;}
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let connection=connection.ok_or("Otter daemon did not start. Another desktop instance may already use this data directory.")?;
        let url=format!("{}/#token={}",connection["url"].as_str().ok_or("Invalid daemon URL")?,connection["token"].as_str().ok_or("Missing daemon token")?);
        tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::External(url.parse()?))
            .title("Otter").inner_size(1440.0,940.0).min_inner_size(900.0,640.0).build()?;
        if std::env::var("OTTER_DESKTOP_SMOKE_TEST").as_deref()==Ok("1") {
            let handle=app.handle().clone();
            std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(5));handle.exit(0);});
        }
        Ok(())
    }).build(tauri::generate_context!()).expect("Unable to initialize Otter desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            app.state::<Daemon>().stop();
        }
    });
}
