//! Files the agent may read and write. Everything stays inside one folder
//! (default: Documents/Credence) so a tool call can never touch other files.

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

const MAX_READ_BYTES: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Joins `rel` to `root`, refusing absolute paths and `..`.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    let p = Path::new(rel);
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("Only paths inside the Credence workspace folder are allowed.".into()),
        }
    }
    Ok(root.join(p))
}

pub fn write(root: &Path, rel: &str, content: &str, overwrite: bool) -> Result<String, String> {
    let path = safe_join(root, rel)?;
    if path == root {
        return Err("A file name is needed.".into());
    }
    if path.exists() && !overwrite {
        return Err(format!("{rel} already exists."));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    let path = safe_join(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|_| format!("{rel} was not found in the workspace."))?;
    if meta.is_dir() {
        return Err(format!("{rel} is a folder."));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{rel} is too big to read ({} KB, limit 512 KB).", meta.len() / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| format!("{rel} is not a text file."))
}

pub fn list(root: &Path, rel: &str) -> Result<Vec<WsEntry>, String> {
    let dir = safe_join(root, rel)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(&dir).map_err(|_| format!("{rel} was not found in the workspace."))?;
    let mut out: Vec<WsEntry> = rd
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let path = e.path().strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
            Some(WsEntry {
                path,
                is_dir: meta.is_dir(),
                size: meta.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.path.cmp(&b.path)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_escape() {
        let root = Path::new("/tmp/ws");
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "a/../../b").is_err());
        assert!(safe_join(root, "notes/today.md").is_ok());
        assert_eq!(safe_join(root, "/abs.txt").unwrap(), root.join("abs.txt"));
    }
}
