//! Model download manager.
//!
//! - Files come from Hugging Face (`/api/models/{repo}/tree/main` for the list,
//!   `/{repo}/resolve/main/{path}` for the bytes). No token needed for public models.
//! - Downloads resume: bytes go to `<file>.part` and continue with an HTTP Range request.
//! - Every LFS file is checked against its SHA-256 from Hugging Face.
//! - Layout: `<models_dir>/<model_id>--<quant>/` holds the files plus `credence-model.json`.
//!   Unfinished jobs are remembered in `<models_dir>/.downloads/<id>.json`.
//!
//! Only `tauri::async_runtime::spawn` comes from Tauri, so the logic can be tested on its own; `lib.rs` wires it up.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Hugging Face base URL. `HF_ENDPOINT` (same variable the HF tools use) allows a mirror.
fn hf() -> String {
    std::env::var("HF_ENDPOINT")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://huggingface.co".into())
        .trim_end_matches('/')
        .to_string()
}
const MANIFEST: &str = "credence-model.json";
const EMIT_EVERY: Duration = Duration::from_millis(250);

/// What the UI asks to download.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSpec {
    pub model_id: String,
    pub name: String,
    pub quant: String,
    pub repo: String,
    /// A file path or a folder inside the repo. Empty = the whole repo.
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Downloading,
    Paused,
    Verifying,
    Done,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub spec: DownloadSpec,
    pub status: JobStatus,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub bytes_per_sec: u64,
    pub error: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub id: String,
    pub model_id: String,
    pub name: String,
    pub quant: String,
    pub repo: String,
    pub files: Vec<String>,
    pub size_bytes: u64,
    pub path: String,
    pub installed_at_ms: u64,
}

#[derive(Deserialize, Debug, Clone)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
    lfs: Option<Lfs>,
}

#[derive(Deserialize, Debug, Clone)]
struct Lfs {
    oid: String,
    size: u64,
}

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

pub fn job_id(model_id: &str, quant: &str) -> String {
    let clean = |s: &str| {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
            .collect::<String>()
    };
    format!("{}--{}", clean(model_id), clean(quant))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lists the files to fetch: `file` itself, or everything under it when it is a folder.
pub async fn list_files(client: &reqwest::Client, repo: &str, file: &str) -> Result<Vec<RemoteFile>, String> {
    let url = format!("{}/api/models/{repo}/tree/main?recursive=true", hf());
    let res = client.get(&url).send().await.map_err(|e| format!("Can't reach Hugging Face: {e}"))?;
    match res.status().as_u16() {
        200 => {}
        401 | 403 => return Err("This model needs a Hugging Face token.".into()),
        404 => return Err(format!("Model {repo} was not found on Hugging Face.")),
        429 => return Err("Hugging Face is busy (rate limit). Try again in a minute.".into()),
        s => return Err(format!("Hugging Face returned error {s}.")),
    }
    let entries: Vec<TreeEntry> = res.json().await.map_err(|e| format!("Unexpected reply from Hugging Face: {e}"))?;
    let prefix = format!("{}/", file.trim_end_matches('/'));
    let files: Vec<RemoteFile> = entries
        .into_iter()
        .filter(|e| e.kind == "file" && (file.is_empty() || e.path == file || e.path.starts_with(&prefix)))
        .map(|e| RemoteFile {
            size: e.lfs.as_ref().map(|l| l.size).unwrap_or(e.size),
            sha256: e.lfs.map(|l| l.oid),
            path: e.path,
        })
        .collect();
    if files.is_empty() {
        return Err(format!("{} was not found in {repo}.", if file.is_empty() { "No files" } else { file }));
    }
    Ok(files)
}

#[derive(Debug)]
pub enum FileError {
    Cancelled,
    Failed(String),
}

impl From<std::io::Error> for FileError {
    fn from(e: std::io::Error) -> Self {
        FileError::Failed(format!("Disk error: {e}"))
    }
}

/// Downloads one file into `dest_dir`, resuming from `<name>.part`.
/// Calls `on_bytes` with every chunk written (including bytes already on disk at the start).
pub async fn download_file(
    client: &reqwest::Client,
    repo: &str,
    f: &RemoteFile,
    dest_dir: &Path,
    cancel: &AtomicBool,
    on_bytes: &mut (dyn FnMut(u64) + Send),
) -> Result<(), FileError> {
    let final_path = dest_dir.join(&f.path);
    let part_path = PathBuf::from(format!("{}.part", final_path.display()));
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    if let Ok(meta) = tokio::fs::metadata(&final_path).await {
        if meta.len() == f.size {
            on_bytes(f.size);
            return Ok(());
        }
    }

    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if let Ok(meta) = tokio::fs::metadata(&part_path).await {
        have = meta.len().min(f.size);
        if have > 0 {
            // Re-hash what is already on disk so the final check covers the whole file.
            let mut existing = tokio::fs::File::open(&part_path).await?;
            let mut buf = vec![0u8; 1 << 20];
            let mut left = have;
            while left > 0 {
                if cancel.load(Ordering::Relaxed) {
                    return Err(FileError::Cancelled);
                }
                let n = existing.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                let n = (n as u64).min(left) as usize;
                hasher.update(&buf[..n]);
                left -= n as u64;
            }
            have -= left;
            on_bytes(have);
        }
    }

    let url = format!("{}/{repo}/resolve/main/{}", hf(), f.path);
    let mut req = client.get(&url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = req
        .send()
        .await
        .map_err(|e| FileError::Failed(format!("Download failed: {e}")))?;
    let status = res.status().as_u16();

    let mut file = match status {
        206 => {
            let file = tokio::fs::OpenOptions::new().write(true).open(&part_path).await?;
            file.set_len(have).await?;
            let mut file = file;
            tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(have)).await?;
            file
        }
        200 => {
            // Server ignored the range: start over.
            if have > 0 {
                on_bytes(0u64.wrapping_sub(have)); // tells the caller to subtract
                hasher = Sha256::new();
            }
            tokio::fs::File::create(&part_path).await?
        }
        416 if have == f.size => tokio::fs::OpenOptions::new().append(true).open(&part_path).await?,
        401 | 403 => return Err(FileError::Failed("This model needs a Hugging Face token.".into())),
        s => return Err(FileError::Failed(format!("Hugging Face returned error {s}."))),
    };

    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            file.flush().await?;
            return Err(FileError::Cancelled);
        }
        let chunk = chunk.map_err(|e| FileError::Failed(format!("Connection lost: {e}")))?;
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        on_bytes(chunk.len() as u64);
    }
    file.flush().await?;
    drop(file);

    let len = tokio::fs::metadata(&part_path).await?.len();
    if len != f.size {
        return Err(FileError::Failed(format!(
            "Download stopped early ({len} of {} bytes). Press resume to continue.",
            f.size
        )));
    }
    if let Some(expected) = &f.sha256 {
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(FileError::Failed(
                "The downloaded file is damaged (checksum mismatch). Please download again.".into(),
            ));
        }
    }
    tokio::fs::rename(&part_path, &final_path).await?;
    Ok(())
}

type Emit = Arc<dyn Fn(&Job) + Send + Sync>;

struct Entry {
    job: Job,
    cancel: Arc<AtomicBool>,
}

/// Keeps every download job, runs them, and reports progress through `emit`.
#[derive(Clone)]
pub struct Manager {
    models_dir: PathBuf,
    client: reqwest::Client,
    jobs: Arc<Mutex<HashMap<String, Entry>>>,
    emit: Emit,
}

impl Manager {
    pub fn new(models_dir: PathBuf, emit: Emit) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!("CredenceAI/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        let m = Manager {
            models_dir,
            client,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            emit,
        };
        m.restore_paused();
        m
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    fn pending_dir(&self) -> PathBuf {
        self.models_dir.join(".downloads")
    }

    fn model_dir(&self, id: &str) -> PathBuf {
        self.models_dir.join(id)
    }

    /// Unfinished downloads from an earlier app run come back as "paused".
    fn restore_paused(&self) {
        let Ok(dir) = std::fs::read_dir(self.pending_dir()) else { return };
        let mut jobs = self.jobs.lock().unwrap();
        for entry in dir.flatten() {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let Ok(mut job) = serde_json::from_str::<Job>(&text) else { continue };
            job.status = JobStatus::Paused;
            job.bytes_per_sec = 0;
            jobs.insert(
                job.id.clone(),
                Entry {
                    job,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
        }
    }

    fn save_pending(&self, job: &Job) {
        let dir = self.pending_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(text) = serde_json::to_string_pretty(job) {
            let _ = std::fs::write(dir.join(format!("{}.json", job.id)), text);
        }
    }

    fn clear_pending(&self, id: &str) {
        let _ = std::fs::remove_file(self.pending_dir().join(format!("{id}.json")));
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) -> Option<Job> {
        let job = {
            let mut jobs = self.jobs.lock().unwrap();
            let entry = jobs.get_mut(id)?;
            f(&mut entry.job);
            entry.job.updated_at_ms = now_ms();
            entry.job.clone()
        };
        (self.emit)(&job);
        Some(job)
    }

    pub fn list(&self) -> Vec<Job> {
        let mut v: Vec<Job> = self.jobs.lock().unwrap().values().map(|e| e.job.clone()).collect();
        v.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
        v
    }

    /// Starts a new download, or resumes a paused / failed one.
    pub fn start(&self, spec: DownloadSpec) -> Job {
        let id = job_id(&spec.model_id, &spec.quant);
        let cancel = Arc::new(AtomicBool::new(false));
        let job = {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(e) = jobs.get(&id) {
                if matches!(e.job.status, JobStatus::Queued | JobStatus::Downloading | JobStatus::Verifying) {
                    return e.job.clone();
                }
            }
            let previous = jobs.get(&id).map(|e| e.job.clone());
            let job = Job {
                id: id.clone(),
                spec,
                status: JobStatus::Queued,
                total_bytes: previous.as_ref().map(|j| j.total_bytes).unwrap_or(0),
                done_bytes: previous.as_ref().map(|j| j.done_bytes).unwrap_or(0),
                bytes_per_sec: 0,
                error: None,
                updated_at_ms: now_ms(),
            };
            jobs.insert(
                id.clone(),
                Entry {
                    job: job.clone(),
                    cancel: cancel.clone(),
                },
            );
            job
        };
        self.save_pending(&job);
        (self.emit)(&job);

        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.run(id, cancel).await });
        job
    }

    pub fn pause(&self, id: &str) {
        if let Some(e) = self.jobs.lock().unwrap().get(id) {
            e.cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Stops the job and deletes its partial files.
    pub async fn remove(&self, id: &str) {
        let entry = self.jobs.lock().unwrap().remove(id);
        if let Some(e) = entry {
            e.cancel.store(true, Ordering::Relaxed);
            let finished = e.job.status == JobStatus::Done;
            if !finished {
                // Give the running task a moment to close its file handle (Windows).
                tokio::time::sleep(Duration::from_millis(300)).await;
                let _ = tokio::fs::remove_dir_all(self.model_dir(id)).await;
            }
        }
        self.clear_pending(id);
    }

    async fn run(&self, id: String, cancel: Arc<AtomicBool>) {
        let Some(spec) = self.jobs.lock().unwrap().get(&id).map(|e| e.job.spec.clone()) else { return };
        let dir = self.model_dir(&id);

        let files = match list_files(&self.client, &spec.repo, &spec.file).await {
            Ok(f) => f,
            Err(e) => {
                self.fail(&id, e);
                return;
            }
        };
        let total: u64 = files.iter().map(|f| f.size).sum();
        self.update(&id, |j| {
            j.status = JobStatus::Downloading;
            j.total_bytes = total;
            j.done_bytes = 0;
        });

        let mut done_before = 0u64;
        for f in &files {
            let mut file_done = 0u64;
            let mut last_emit = Instant::now();
            let mut bytes_at_last_emit = done_before;
            let me = self.clone();
            let id2 = id.clone();
            let mut on_bytes = |n: u64| {
                file_done = file_done.wrapping_add(n);
                let now_done = done_before + file_done;
                let elapsed = last_emit.elapsed();
                if elapsed >= EMIT_EVERY {
                    let speed = (now_done.saturating_sub(bytes_at_last_emit)) as f64 / elapsed.as_secs_f64();
                    bytes_at_last_emit = now_done;
                    last_emit = Instant::now();
                    me.update(&id2, |j| {
                        j.done_bytes = now_done;
                        // Smooth the speed so the time-left text does not jump around.
                        j.bytes_per_sec = if j.bytes_per_sec == 0 {
                            speed as u64
                        } else {
                            (j.bytes_per_sec as f64 * 0.7 + speed * 0.3) as u64
                        };
                    });
                }
            };
            match download_file(&self.client, &spec.repo, f, &dir, &cancel, &mut on_bytes).await {
                Ok(()) => done_before += f.size,
                Err(FileError::Cancelled) => {
                    let done = done_before + file_done;
                    if let Some(job) = self.update(&id, |j| {
                        j.status = JobStatus::Paused;
                        j.done_bytes = done;
                        j.bytes_per_sec = 0;
                    }) {
                        self.save_pending(&job);
                    }
                    return;
                }
                Err(FileError::Failed(e)) => {
                    self.fail(&id, e);
                    return;
                }
            }
        }

        self.update(&id, |j| {
            j.status = JobStatus::Verifying;
            j.done_bytes = total;
        });
        let installed = InstalledModel {
            id: id.clone(),
            model_id: spec.model_id.clone(),
            name: spec.name.clone(),
            quant: spec.quant.clone(),
            repo: spec.repo.clone(),
            files: files.iter().map(|f| f.path.clone()).collect(),
            size_bytes: total,
            path: dir.to_string_lossy().into_owned(),
            installed_at_ms: now_ms(),
        };
        let manifest = serde_json::to_string_pretty(&installed).unwrap_or_default();
        if let Err(e) = tokio::fs::write(dir.join(MANIFEST), manifest).await {
            self.fail(&id, format!("Disk error: {e}"));
            return;
        }
        self.clear_pending(&id);
        self.update(&id, |j| {
            j.status = JobStatus::Done;
            j.bytes_per_sec = 0;
        });
    }

    fn fail(&self, id: &str, error: String) {
        if let Some(job) = self.update(id, |j| {
            j.status = JobStatus::Error;
            j.error = Some(error);
            j.bytes_per_sec = 0;
        }) {
            self.save_pending(&job);
        }
    }

    /// Models with a finished `credence-model.json`.
    pub fn installed(&self) -> Vec<InstalledModel> {
        let Ok(dir) = std::fs::read_dir(&self.models_dir) else { return vec![] };
        let mut out: Vec<InstalledModel> = dir
            .flatten()
            .filter_map(|e| std::fs::read_to_string(e.path().join(MANIFEST)).ok())
            .filter_map(|t| serde_json::from_str(&t).ok())
            .collect();
        out.sort_by(|a, b| b.installed_at_ms.cmp(&a.installed_at_ms));
        out
    }

    pub async fn delete_installed(&self, id: &str) -> Result<(), String> {
        if id.contains('/') || id.contains('\\') || id.starts_with('.') || id.is_empty() {
            return Err("Invalid model id".into());
        }
        let dir = self.model_dir(id);
        if !dir.join(MANIFEST).exists() {
            return Err("Model is not installed".into());
        }
        tokio::fs::remove_dir_all(&dir).await.map_err(|e| e.to_string())?;
        self.jobs.lock().unwrap().remove(id);
        Ok(())
    }
}
