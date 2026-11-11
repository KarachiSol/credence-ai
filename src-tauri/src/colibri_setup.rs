//! Installs the Colibri engine for the user, so nobody has to unzip or point at a
//! folder. The prebuilt release for this OS is downloaded from GitHub into
//! `<app data>/colibri/<tag>/` and checked against the release's SHA256SUMS.txt.
//! Colibri's launcher (`coli`) is a Python 3.10+ script, so Python is checked too.
//!
//! The version is pinned in `colibri-version.txt`. On Linux the app also ships the
//! engines built by our CI on an older Ubuntu (`overlay`): Colibri's own Linux
//! engines are built on the newest Ubuntu and need a glibc that older systems lack.

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::io::AsyncWriteExt;

const RELEASES_API: &str = "https://api.github.com/repos/JustVugg/colibri/releases/tags/";
const CURRENT_FILE: &str = "current.txt";
/// Written after our engines were unpacked over the release; holds the overlay's size.
const OVERLAY_MARK: &str = ".credence-engines";

/// The Colibri release this version of Credence uses.
pub fn pinned_tag() -> &'static str {
    include_str!("../../colibri-version.txt").trim()
}

fn overlay_stamp(overlay: &Path) -> String {
    std::fs::metadata(overlay).map(|m| m.len().to_string()).unwrap_or_default()
}

fn overlay_current(dir: &Path, overlay: Option<&Path>) -> bool {
    match overlay {
        None => true,
        Some(o) => std::fs::read_to_string(dir.join(OVERLAY_MARK)).is_ok_and(|s| s.trim() == overlay_stamp(o)),
    }
}

fn apply_overlay(dir: &Path, overlay: &Path) -> Result<(), String> {
    extract(overlay, dir)?;
    std::fs::write(dir.join(OVERLAY_MARK), overlay_stamp(overlay)).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColibriInfo {
    /// A prebuilt engine exists for this OS and processor.
    pub supported: bool,
    pub installed: bool,
    pub dir: Option<String>,
    pub version: Option<String>,
    /// e.g. "3.12.3"; None when no Python 3.10+ was found.
    pub python: Option<String>,
    /// How to install Python on this system, shown when it is missing.
    pub python_hint: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// checking | downloading | verifying | extracting | done | error
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
}

impl Progress {
    fn phase(phase: &str) -> Self {
        Progress { phase: phase.into(), done: 0, total: 0, message: None }
    }
}

/// The release archive suffix for this machine, as Colibri names them.
pub fn asset_suffix() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64.tar.gz"),
        ("macos", "aarch64") => Some("macos-arm64.tar.gz"),
        ("windows", "x86_64") => Some("windows-x86_64.zip"),
        _ => None,
    }
}

fn root(app_data: &Path) -> PathBuf {
    app_data.join("colibri")
}

/// The folder of the installed engine, if any.
/// The unpacked release, whatever its state.
fn unpacked_dir(app_data: &Path) -> Option<(PathBuf, String)> {
    let root = root(app_data);
    let tag = std::fs::read_to_string(root.join(CURRENT_FILE)).ok()?.trim().to_string();
    let dir = root.join(&tag);
    dir.is_dir().then_some((dir, tag))
}

/// The engine folder, when the pinned version is installed and ready to run.
pub fn installed_dir(app_data: &Path, overlay: Option<&Path>) -> Option<(PathBuf, String)> {
    let (dir, tag) = unpacked_dir(app_data)?;
    (tag == pinned_tag() && overlay_current(&dir, overlay)).then_some((dir, tag))
}

fn python_hint() -> String {
    if cfg!(windows) {
        "Install Python 3 from python.org (tick \"Add python.exe to PATH\") or run: winget install Python.Python.3.12".into()
    } else if cfg!(target_os = "macos") {
        "Install Python 3 with: brew install python".into()
    } else if which("apt").is_some() {
        "Install Python 3 with: sudo apt install python3".into()
    } else if which("dnf").is_some() {
        "Install Python 3 with: sudo dnf install python3".into()
    } else if which("pacman").is_some() {
        "Install Python 3 with: sudo pacman -S python".into()
    } else {
        "Install Python 3.10 or newer from your distribution.".into()
    }
}

fn which(cmd: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(cmd)).find(|p| p.is_file())
}

fn no_window(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Python 3.10+ version string, if one is on PATH.
pub fn python_version() -> Option<String> {
    let candidates: &[&[&str]] = if cfg!(windows) { &[&["py", "-3"], &["python"], &["python3"]] } else { &[&["python3"], &["python"]] };
    for c in candidates {
        let mut cmd = Command::new(c[0]);
        cmd.args(&c[1..]).args(["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"]);
        let Ok(out) = no_window(&mut cmd).output() else { continue };
        if !out.status.success() {
            continue;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let mut parts = v.split('.').filter_map(|p| p.parse::<u32>().ok());
        if let (Some(major), Some(minor)) = (parts.next(), parts.next()) {
            if major == 3 && minor >= 10 {
                return Some(v);
            }
        }
    }
    None
}

pub fn info(app_data: &Path, overlay: Option<&Path>) -> ColibriInfo {
    let installed = installed_dir(app_data, overlay);
    ColibriInfo {
        supported: asset_suffix().is_some(),
        installed: installed.is_some(),
        dir: installed.as_ref().map(|(d, _)| d.to_string_lossy().into_owned()),
        version: installed.map(|(_, t)| t),
        python: python_version(),
        python_hint: python_hint(),
    }
}

#[derive(Debug, PartialEq)]
struct Release {
    tag: String,
    archive: (String, String),
    sums: Option<String>,
}

fn pick_release(json: &serde_json::Value, suffix: &str) -> Result<Release, String> {
    let tag = json["tag_name"].as_str().ok_or("The Colibri release has no tag.")?.to_string();
    let assets: Vec<(String, String)> = json["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| Some((x["name"].as_str()?.to_string(), x["browser_download_url"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let exact = format!("colibri-{tag}-{suffix}");
    let archive = assets
        .iter()
        .find(|(n, _)| *n == exact)
        .or_else(|| assets.iter().find(|(n, _)| n.ends_with(suffix) && !n.contains("cuda")))
        .cloned()
        .ok_or_else(|| format!("Colibri {tag} has no download for this computer ({suffix})."))?;
    let sums = assets.iter().find(|(n, _)| n == "SHA256SUMS.txt").map(|(_, u)| u.clone());
    Ok(Release { tag, archive, sums })
}

fn parse_sums(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let hash = it.next()?;
            let name = it.next()?.trim_start_matches('*');
            (hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())).then(|| (name.to_string(), hash.to_lowercase()))
        })
        .collect()
}

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // tar handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar ships with it).
    let tar = if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        PathBuf::from(sys).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let flags = if archive.extension().is_some_and(|e| e == "zip") { "-xf" } else { "-xzf" };
    let mut cmd = Command::new(tar);
    cmd.arg(flags).arg(archive).arg("-C").arg(dest);
    let out = no_window(&mut cmd).output().map_err(|e| format!("Could not unpack Colibri: {e}"))?;
    if !out.status.success() {
        return Err(format!("Could not unpack Colibri: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    // Scripts without an extension (coli) must be executable.
    #[cfg(unix)]
    mark_executable(dest);
    Ok(())
}

#[cfg(unix)]
fn mark_executable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            mark_executable(&p);
        } else if p.extension().is_none() {
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
        }
    }
}

/// Downloads and unpacks the latest Colibri release. Reports progress through `emit`.
pub async fn install(
    app_data: &Path,
    overlay: Option<&Path>,
    emit: &(dyn Fn(Progress) + Send + Sync),
) -> Result<ColibriInfo, String> {
    let suffix = asset_suffix().ok_or("Colibri has no ready-made engine for this computer yet.")?;
    emit(Progress::phase("checking"));
    // The right version is unpacked already, only our engines are missing or older.
    if let (Some((dir, tag)), Some(o)) = (unpacked_dir(app_data), overlay) {
        if tag == pinned_tag() {
            emit(Progress::phase("extracting"));
            let (d, o) = (dir.clone(), o.to_path_buf());
            tokio::task::spawn_blocking(move || apply_overlay(&d, &o)).await.map_err(|e| e.to_string())??;
            emit(Progress::phase("done"));
            return Ok(info(app_data, overlay));
        }
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("CredenceAI/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let api = std::env::var("CREDENCE_COLIBRI_API").unwrap_or_else(|_| format!("{RELEASES_API}{}", pinned_tag()));
    let json: serde_json::Value = client
        .get(&api)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Can't reach GitHub to download Colibri. Check your internet connection. ({e})"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let release = pick_release(&json, suffix)?;
    let root = root(app_data);
    let dest = root.join(&release.tag);
    if let Some((_, tag)) = installed_dir(app_data, overlay) {
        if tag == release.tag {
            emit(Progress::phase("done"));
            return Ok(info(app_data, overlay));
        }
    }

    let expected = match &release.sums {
        Some(url) => {
            let text = client
                .get(url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("Could not read Colibri's checksums: {e}"))?
                .text()
                .await
                .map_err(|e| e.to_string())?;
            parse_sums(&text).into_iter().find(|(n, _)| *n == release.archive.0).map(|(_, h)| h)
        }
        None => None,
    };

    tokio::fs::create_dir_all(&root).await.map_err(|e| e.to_string())?;
    let archive_path = root.join(&release.archive.0);
    let res = client
        .get(&release.archive.1)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Colibri download failed: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&archive_path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut last = std::time::Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Colibri download stopped: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if last.elapsed().as_millis() > 200 {
            last = std::time::Instant::now();
            emit(Progress { phase: "downloading".into(), done, total, message: None });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    emit(Progress::phase("verifying"));
    if let Some(want) = expected {
        let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != want {
            let _ = std::fs::remove_file(&archive_path);
            return Err("The Colibri download was damaged (checksum mismatch). Try again.".into());
        }
    }

    emit(Progress::phase("extracting"));
    let staging = root.join(format!("{}.partial", release.tag));
    let (a, s, d) = (archive_path.clone(), staging.clone(), dest.clone());
    let o = overlay.map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&s);
        extract(&a, &s)?;
        if let Some(o) = o {
            apply_overlay(&s, &o)?;
        }
        let _ = std::fs::remove_dir_all(&d);
        std::fs::rename(&s, &d).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&archive_path);
    std::fs::write(root.join(CURRENT_FILE), &release.tag).map_err(|e| e.to_string())?;

    // Remove older versions.
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && p != dest {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }
    emit(Progress::phase("done"));
    Ok(info(app_data, overlay))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_archive_for_this_os() {
        let json = serde_json::json!({
            "tag_name": "v2.1.0",
            "assets": [
                {"name": "colibri-v2.1.0-windows-x86_64-cuda.zip", "browser_download_url": "u0"},
                {"name": "colibri-v2.1.0-linux-x86_64.tar.gz", "browser_download_url": "u1"},
                {"name": "colibri-v2.1.0-windows-x86_64.zip", "browser_download_url": "u2"},
                {"name": "SHA256SUMS.txt", "browser_download_url": "u3"}
            ]
        });
        let r = pick_release(&json, "linux-x86_64.tar.gz").unwrap();
        assert_eq!(r.archive.1, "u1");
        assert_eq!(r.sums.as_deref(), Some("u3"));
        assert_eq!(pick_release(&json, "windows-x86_64.zip").unwrap().archive.1, "u2");
        assert!(pick_release(&json, "macos-arm64.tar.gz").is_err());
    }

    #[test]
    fn parses_checksums() {
        let h = "a".repeat(64);
        let sums = parse_sums(&format!("{h}  colibri-v2.1.0-linux-x86_64.tar.gz\n{h} *x.zip\nnot a line\n"));
        assert_eq!(sums.len(), 2);
        assert_eq!(sums[1].0, "x.zip");
    }

    #[test]
    fn extracts_and_marks_executable() {
        let root = std::env::temp_dir().join(format!("credence-colibri-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/coli"), "#!/usr/bin/env python3\n").unwrap();
        let archive = root.join("a.tar.gz");
        let ok = Command::new("tar").arg("-czf").arg(&archive).arg("-C").arg(root.join("src")).arg("coli").status().unwrap();
        assert!(ok.success());
        extract(&archive, &root.join("out")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.join("out/coli")).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
