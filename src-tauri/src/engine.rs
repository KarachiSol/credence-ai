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

fn launcher(colibri_dir: &Path) -> Result<PathBuf, String> {
    let names: &[&str] = if cfg!(windows) { &["coli.cmd", "coli.bat", "coli.exe"] } else { &["coli"] };
    for n in names {
        let p = colibri_dir.join(n);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(format!(
        "Colibri launcher ({}) not found in {}. Pick the folder you unzipped Colibri into.",
        names[0],
        colibri_dir.display()
    ))
}

fn command(launcher: &Path) -> Command {
    let is_script = launcher
        .extension()
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut c = if is_script {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(launcher);
        c
    } else {
        Command::new(launcher)
    };
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
            let _ = child.kill();
            let _ = child.wait();
            self.log("Engine stopped.".into());
        }
        inner.model_dir = None;
    }
}
