mod colibri_setup;
mod downloads;
mod engine;
mod hardware;
mod workspace;

use downloads::{DownloadSpec, InstalledModel, Job, Manager};
use std::sync::Arc;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager as _, State};

/// Scans CPU, RAM, GPU and the disk that will hold the models.
/// Runs on a blocking thread because GPU detection calls OS tools.
#[tauri::command]
async fn scan_hardware(downloads: State<'_, Manager>) -> Result<hardware::HardwareProfile, String> {
    let models_dir = downloads.models_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || hardware::scan(&models_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn downloads_list(downloads: State<'_, Manager>) -> Vec<Job> {
    downloads.list()
}

#[tauri::command]
fn download_start(downloads: State<'_, Manager>, spec: DownloadSpec) -> Job {
    downloads.start(spec)
}

#[tauri::command]
fn download_pause(downloads: State<'_, Manager>, id: String) {
    downloads.pause(&id)
}

#[tauri::command]
async fn download_remove(downloads: State<'_, Manager>, id: String) -> Result<(), String> {
    downloads.remove(&id).await;
    Ok(())
}

#[tauri::command]
fn installed_list(downloads: State<'_, Manager>) -> Vec<InstalledModel> {
    downloads.installed()
}

#[tauri::command]
async fn installed_delete(downloads: State<'_, Manager>, id: String) -> Result<(), String> {
    downloads.delete_installed(&id).await
}

// ---- Engine (Colibri) ----

/// One install at a time.
#[derive(Default)]
struct InstallLock(tokio::sync::Mutex<()>);

/// Linux packages ship Colibri engines built for older glibc (see colibri_setup).
fn engine_overlay(app: &tauri::AppHandle) -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    app.path()
        .resolve("colibri-engines-linux.tar.gz", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
}

#[tauri::command]
async fn colibri_info(app: tauri::AppHandle) -> Result<colibri_setup::ColibriInfo, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let overlay = engine_overlay(&app);
    tauri::async_runtime::spawn_blocking(move || colibri_setup::info(&data, overlay.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn colibri_install(app: tauri::AppHandle, lock: State<'_, InstallLock>) -> Result<colibri_setup::ColibriInfo, String> {
    let _guard = lock.0.lock().await;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let handle = app.clone();
    let emit = move |p: colibri_setup::Progress| {
        let _ = handle.emit("colibri-setup", p);
    };
    let overlay = engine_overlay(&app);
    let result = colibri_setup::install(&data, overlay.as_deref(), &emit).await;
    if let Err(e) = &result {
        let _ = app.emit(
            "colibri-setup",
            colibri_setup::Progress { phase: "error".into(), done: 0, total: 0, message: Some(e.clone()) },
        );
    }
    result
}

#[tauri::command]
async fn engine_start(
    app: tauri::AppHandle,
    engine: State<'_, engine::Engine>,
    colibri_dir: String,
    model_dir: String,
    extra_args: Option<Vec<String>>,
    env: Option<Vec<(String, String)>>,
    note: Option<String>,
) -> Result<engine::EngineStatus, String> {
    let engine = engine.inner().clone();
    // No folder chosen: use the engine Credence installed itself.
    let dir = if colibri_dir.trim().is_empty() {
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        colibri_setup::installed_dir(&data, engine_overlay(&app).as_deref())
            .map(|(d, _)| d)
            .ok_or("The Colibri engine is not installed yet.")?
    } else {
        engine::expand_home(colibri_dir.trim())
    };
    tauri::async_runtime::spawn_blocking(move || {
        engine.start(
            &dir,
            &PathBuf::from(model_dir),
            &extra_args.unwrap_or_default(),
            &env.unwrap_or_default(),
            note.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn engine_stop(engine: State<'_, engine::Engine>) {
    engine.stop()
}

#[tauri::command]
fn engine_status(engine: State<'_, engine::Engine>) -> engine::EngineStatus {
    engine.status()
}

#[tauri::command]
fn engine_logs(engine: State<'_, engine::Engine>) -> Vec<String> {
    engine.logs()
}

// ---- Workspace files for agent tools ----

fn workspace_dir(app: &tauri::AppHandle, custom: Option<String>) -> Result<PathBuf, String> {
    match custom.filter(|c| !c.trim().is_empty()) {
        Some(c) => Ok(PathBuf::from(c)),
        None => app
            .path()
            .document_dir()
            .map(|d| d.join("Credence"))
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn workspace_root(app: tauri::AppHandle, root: Option<String>) -> Result<String, String> {
    let dir = workspace_dir(&app, root)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn workspace_write(
    app: tauri::AppHandle,
    root: Option<String>,
    path: String,
    content: String,
    overwrite: bool,
) -> Result<String, String> {
    workspace::write(&workspace_dir(&app, root)?, &path, &content, overwrite)
}

#[tauri::command]
fn workspace_read(app: tauri::AppHandle, root: Option<String>, path: String) -> Result<String, String> {
    workspace::read(&workspace_dir(&app, root)?, &path)
}

#[tauri::command]
fn workspace_list(
    app: tauri::AppHandle,
    root: Option<String>,
    path: String,
) -> Result<Vec<workspace::WsEntry>, String> {
    workspace::list(&workspace_dir(&app, root)?, &path)
}

// ---- Web access for the search / read-page tools ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPage {
    status: u16,
    final_url: String,
    content_type: String,
    body: String,
}

const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;

/// GET (or form POST) a web page from Rust so CORS and browser limits don't apply.
#[tauri::command]
async fn web_fetch(
    url: String,
    form: Option<Vec<(String, String)>>,
    headers: Option<Vec<(String, String)>>,
) -> Result<WebPage, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links can be opened.".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match form {
        Some(f) => client.post(&url).form(&f),
        None => client.get(&url),
    };
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k, v);
    }
    let res = req
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Could not open {url}: {e}"))?;
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        body.extend_from_slice(&chunk);
        if body.len() > MAX_PAGE_BYTES {
            break;
        }
    }
    Ok(WebPage {
        status,
        final_url,
        content_type,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Opens any folder (workspace, engine) in the system file manager.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens a web link in the user's default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only web links can be opened.".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        // `start` handles URLs with & correctly; the empty "" is the window title.
        let mut c = std::process::Command::new("cmd");
        use std::os::windows::process::CommandExt;
        c.args(["/C", "start", ""]).arg(&url).creation_flags(0x0800_0000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens the models folder in Explorer / Finder / the file manager.
#[tauri::command]
fn open_models_folder(downloads: State<'_, Manager>) -> Result<(), String> {
    let dir = downloads.models_dir();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .manage(engine::Engine::default())
        .manage(InstallLock::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let models_dir = app.path().app_data_dir()?.join("models");
            let handle = app.handle().clone();
            let manager = Manager::new(
                models_dir,
                Arc::new(move |job: &Job| {
                    let _ = handle.emit("download-update", job);
                }),
            );
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_hardware,
            downloads_list,
            download_start,
            download_pause,
            download_remove,
            installed_list,
            installed_delete,
            open_models_folder,
            colibri_info,
            colibri_install,
            engine_start,
            engine_stop,
            engine_status,
            engine_logs,
            workspace_root,
            workspace_write,
            workspace_read,
            workspace_list,
            web_fetch,
            open_folder,
            open_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Credence AI")
        .run(|app, event| {
            // Never leave the engine running after the app closes.
            if let tauri::RunEvent::Exit = event {
                app.state::<engine::Engine>().stop();
            }
        });
}
