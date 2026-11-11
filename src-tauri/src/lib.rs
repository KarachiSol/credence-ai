mod downloads;
mod hardware;

use downloads::{DownloadSpec, InstalledModel, Job, Manager};
use std::sync::Arc;
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
            open_models_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Credence AI");
}
