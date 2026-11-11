//! Runs the Colibri engine (`coli serve`) as a child process.
//!
//! The user points Credence at their Colibri folder (the release zip, which has
//! `coli.cmd` on Windows or `coli` elsewhere). GGUF models are imported once with
//! `coli import`, which writes `<name>.colibri` next to the file.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const MAX_LOG_LINES: usize = 400;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub model_dir: Option<String>,
    pub pid: Option<u32>,
    pub exit_message: Option<String>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    model_dir: Option<String>,
    exit_message: Option<String>,
}

#[derive(Clone, Default)]
pub struct Engine {
    inner: Arc<Mutex<Inner>>,
    logs: Arc<Mutex<VecDeque<String>>>,
}

/// `~/colibri` -> `/home/me/colibri`.
pub fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), home) {
        (Some(rest), Some(h)) => PathBuf::from(h).join(rest),
        _ if p == "~" => std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(p)),
        _ => PathBuf::from(p),
    }
}

const LAUNCHER_NAMES: &[&str] = if cfg!(windows) { &["coli.cmd", "coli.bat", "coli.exe", "coli"] } else { &["coli"] };

/// Folders that may hold the launcher: the folder itself, its `c/` (a source
/// checkout keeps `coli` there), and the same one level down, because release
/// archives usually unpack into their own subfolder.
fn launcher_candidates(colibri_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![colibri_dir.to_path_buf(), colibri_dir.join("c")];
    if let Ok(rd) = std::fs::read_dir(colibri_dir) {
        let mut subs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        subs.sort();
        for s in subs {
            dirs.push(s.join("c"));
            dirs.push(s);
        }
    }
    dirs
}

fn launcher(colibri_dir: &Path) -> Result<PathBuf, String> {
    for dir in launcher_candidates(colibri_dir) {
        for n in LAUNCHER_NAMES {
            let p = dir.join(n);
            if p.is_file() {
                // Absolute, because the command runs with the launcher's folder as cwd.
                return Ok(std::path::absolute(&p).unwrap_or(p));
            }
        }
    }
    let hint = if cfg!(windows) {
        "Pick the folder you unzipped the Colibri release into (it has coli.cmd)."
    } else {
        "Pick the folder you unzipped the Colibri release into, or your colibri git checkout (coli is in its c/ folder)."
    };
    Err(format!("Colibri launcher (coli) not found in {} or its subfolders. {hint}", colibri_dir.display()))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn command(launcher: &Path) -> Command {
    let ext = launcher.extension().map(|e| e.to_ascii_lowercase());
    let is_batch = ext.as_deref().is_some_and(|e| e == "cmd" || e == "bat");
    let is_exe = ext.as_deref().is_some_and(|e| e == "exe");
    let mut c = if is_batch {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(launcher);
        c
    } else if is_exe {
        Command::new(launcher)
    } else if cfg!(windows) {
        // A source checkout: `coli` is a Python script.
        let mut c = Command::new("py");
        c.arg("-3").arg(launcher);
        c
    } else {
        // `coli` is a Python script. Unzipping can drop the executable bit, so run it
        // through python3 unless it is marked executable.
        #[cfg(unix)]
        let direct = is_executable(launcher);
        #[cfg(not(unix))]
        let direct = true;
        if direct {
            Command::new(launcher)
        } else {
            let mut c = Command::new("python3");
            c.arg(launcher);
            c
        }
    };
    // Own process group, so stopping also ends the engine the launcher starts.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    if let Some(dir) = launcher.parent() {
        c.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// A folder from the download manager: use an existing `.colibri` folder, a Colibri
/// container (has config.json), or import the first GGUF file.
fn resolve_model(launcher: &Path, model_dir: &Path, log: &dyn Fn(String)) -> Result<PathBuf, String> {
    let entries: Vec<PathBuf> = walk(model_dir);
    if let Some(p) = entries.iter().find(|p| p.is_dir() && p.extension().is_some_and(|e| e == "colibri")) {
        return Ok(p.clone());
    }
    let mut ggufs: Vec<&PathBuf> = entries
        .iter()
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("gguf")))
        .collect();
    ggufs.sort();
    let Some(first) = ggufs.first() else {
        // Not a GGUF: assume it is already a Colibri model folder.
        return Ok(model_dir.to_path_buf());
    };
    log(format!("Preparing model (one time): coli import {}", first.display()));
    let out = command(launcher)
        .arg("import")
        .arg(first)
        .output()
        .map_err(|e| format!("Could not run Colibri: {e}"))?;
    for line in String::from_utf8_lossy(&out.stdout).lines().chain(String::from_utf8_lossy(&out.stderr).lines()) {
        log(line.to_string());
    }
    if !out.status.success() {
        return Err("Colibri could not import this model. See the engine log.".into());
    }
    let stem = first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let imported = first.with_file_name(format!("{stem}.colibri"));
    if imported.exists() {
        Ok(imported)
    } else {
        walk(model_dir)
            .into_iter()
            .find(|p| p.is_dir() && p.extension().is_some_and(|e| e == "colibri"))
            .ok_or_else(|| "Import finished but no .colibri folder was created.".into())
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && p.extension().is_none_or(|x| x != "colibri") {
                stack.push(p.clone());
            }
            out.push(p);
        }
    }
    out
}

impl Engine {
    fn log(&self, line: String) {
        let mut l = self.logs.lock().unwrap();
        if l.len() >= MAX_LOG_LINES {
            l.pop_front();
        }
        l.push_back(line);
    }

    pub fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    pub fn status(&self) -> EngineStatus {
        let mut inner = self.inner.lock().unwrap();
        let mut exited = None;
        if let Some(child) = inner.child.as_mut() {
            if let Ok(Some(code)) = child.try_wait() {
                exited = Some(format!("Engine stopped (exit code {:?}).", code.code()));
            }
        }
        if let Some(msg) = exited {
            inner.child = None;
            inner.exit_message = Some(msg);
        }
        EngineStatus {
            running: inner.child.is_some(),
            model_dir: inner.model_dir.clone(),
            pid: inner.child.as_ref().map(|c| c.id()),
            exit_message: inner.exit_message.clone(),
        }
    }

    /// Blocking: may run `coli import` first. Call from a blocking thread.
    pub fn start(&self, colibri_dir: &Path, model_dir: &Path, extra_args: &[String]) -> Result<EngineStatus, String> {
        self.stop();
        self.logs.lock().unwrap().clear();
        let launcher = launcher(colibri_dir)?;
        let me = self.clone();
        let model = resolve_model(&launcher, model_dir, &move |l| me.log(l))?;

        self.log(format!("Starting: coli serve --model {}", model.display()));
        let mut child = command(&launcher)
            .arg("serve")
            .arg("--model")
            .arg(&model)
            .args(extra_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not start Colibri: {e}"))?;

        for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)]
            .into_iter()
            .flatten()
        {
            let me = self.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    me.log(line);
                }
            });
        }

        let mut inner = self.inner.lock().unwrap();
        inner.child = Some(child);
        inner.model_dir = Some(model_dir.to_string_lossy().into_owned());
        inner.exit_message = None;
        drop(inner);
        Ok(self.status())
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mut child) = inner.child.take() {
            // `cmd /C coli.cmd` starts the engine as a grandchild: kill the whole tree.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &child.id().to_string()])
                    .creation_flags(0x0800_0000)
                    .status();
            }
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", child.id())]).status();
                for _ in 0..20 {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status();
            }
            let _ = child.kill();
            let _ = child.wait();
            self.log("Engine stopped.".into());
        }
        inner.model_dir = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_launcher_in_checkout_and_subfolder() {
        let root = std::env::temp_dir().join(format!("credence-launcher-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let name = if cfg!(windows) { "coli.cmd" } else { "coli" };
        // A git checkout: <root>/colibri/c/coli, user picked <root>.
        std::fs::create_dir_all(root.join("colibri/c")).unwrap();
        std::fs::write(root.join("colibri/c").join(name), "").unwrap();
        let want = std::path::absolute(root.join("colibri/c").join(name)).unwrap();
        assert_eq!(launcher(&root).unwrap(), want);
        assert_eq!(launcher(&root.join("colibri")).unwrap(), want);
        assert!(launcher(&root.join("colibri/c/missing")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn expands_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        if !cfg!(windows) && !home.is_empty() {
            assert_eq!(expand_home("~/colibri"), PathBuf::from(&home).join("colibri"));
        }
        assert_eq!(expand_home("/opt/colibri"), PathBuf::from("/opt/colibri"));
    }
}
