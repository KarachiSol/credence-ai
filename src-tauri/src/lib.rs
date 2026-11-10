mod hardware;

use tauri::Manager;

/// Scans CPU, RAM, GPU and the disk that will hold the models.
/// Runs on a blocking thread because GPU detection calls OS tools.
#[tauri::command]
async fn scan_hardware(app: tauri::AppHandle) -> Result<hardware::HardwareProfile, String> {
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    tauri::async_runtime::spawn_blocking(move || hardware::scan(&models_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_hardware])
        .run(tauri::generate_context!())
        .expect("error while running Credence AI");
}
