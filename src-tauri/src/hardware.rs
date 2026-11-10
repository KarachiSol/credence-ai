//! Hardware profile used by the model fit score.
//! Everything here stays on the user's machine.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{DiskKind, Disks, System};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// "nvidia" | "amd" | "intel" | "apple" | "other"
    pub vendor: String,
    /// Dedicated video memory, when the OS reports it.
    pub vram_bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount_point: String,
    /// "nvme" | "ssd" | "hdd" | "unknown"
    pub kind: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub os_name: String,
    pub os_version: String,
    pub cpu_brand: String,
    pub cpu_arch: String,
    pub physical_cores: Option<usize>,
    pub logical_cores: usize,
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    /// Apple Silicon: GPU and CPU share the same RAM.
    pub unified_memory: bool,
    pub gpus: Vec<GpuInfo>,
    pub models_dir: String,
    pub models_disk: Option<DiskInfo>,
    pub scanned_at_ms: u64,
}

pub fn scan(models_dir: &Path) -> Result<HardwareProfile, String> {
    let mut sys = System::new().map_err(|e| e.to_string())?;
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();
    let cpu_arch = System::cpu_arch();
    let unified_memory = cfg!(target_os = "macos") && cpu_arch.contains("arm")
        || cfg!(target_os = "macos") && cpu_arch.contains("aarch64");

    let gpus = if unified_memory {
        vec![GpuInfo {
            name: format!("{cpu_brand} GPU"),
            vendor: "apple".into(),
            vram_bytes: None,
        }]
    } else {
        detect_gpus()
    };

    Ok(HardwareProfile {
        os_name: System::name().unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        cpu_brand,
        cpu_arch,
        physical_cores: System::physical_core_count().ok(),
        logical_cores: sys.cpus().len(),
        total_ram_bytes: sys.total_memory(),
        available_ram_bytes: sys.available_memory(),
        unified_memory,
        gpus,
        models_dir: models_dir.to_string_lossy().into_owned(),
        models_disk: models_disk(models_dir, unified_memory),
        scanned_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// The disk whose mount point is the longest prefix of the models folder.
fn models_disk(models_dir: &Path, apple_silicon: bool) -> Option<DiskInfo> {
    let disks = Disks::new_with_refreshed_list().ok()?;
    let disk = (&disks)
        .into_iter()
        .filter(|d| models_dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())?;

    let name = disk.name().to_string_lossy().to_lowercase();
    let kind = match disk.kind() {
        DiskKind::HDD => "hdd",
        // Apple Silicon Macs only ship with NVMe internal storage.
        DiskKind::SSD if name.contains("nvme") || apple_silicon => "nvme",
        DiskKind::SSD => "ssd",
        DiskKind::Unknown(_) if name.contains("nvme") => "nvme",
        DiskKind::Unknown(_) => "unknown",
    };

    Some(DiskInfo {
        mount_point: disk.mount_point().to_string_lossy().into_owned(),
        kind: kind.into(),
        total_bytes: disk.total_space(),
        available_bytes: disk.available_space(),
    })
}

fn vendor_of(name: &str) -> String {
    let n = name.to_lowercase();
    let vendor = if n.contains("nvidia") || n.contains("geforce") || n.contains("rtx") || n.contains("quadro") {
        "nvidia"
    } else if n.contains("amd") || n.contains("radeon") || n.contains("ati ") {
        "amd"
    } else if n.contains("intel") {
        "intel"
    } else if n.contains("apple") {
        "apple"
    } else {
        "other"
    };
    vendor.to_string()
}

/// Runs a command and returns stdout, or None if the tool is missing or fails.
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let out = c.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Best-effort GPU list. NVIDIA VRAM comes from nvidia-smi when installed.
fn detect_gpus() -> Vec<GpuInfo> {
    let mut gpus: Vec<GpuInfo> = Vec::new();

    if let Some(out) = run(
        "nvidia-smi",
        &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    ) {
        for line in out.lines() {
            let mut parts = line.split(',').map(str::trim);
            if let (Some(name), Some(mib)) = (parts.next(), parts.next()) {
                gpus.push(GpuInfo {
                    name: name.to_string(),
                    vendor: "nvidia".into(),
                    vram_bytes: mib.parse::<u64>().ok().map(|m| m * 1024 * 1024),
                });
            }
        }
    }

    for (name, vram) in os_gpu_list() {
        let vendor = vendor_of(&name);
        // nvidia-smi already gave better data for NVIDIA cards.
        if vendor == "nvidia" && gpus.iter().any(|g| g.vendor == "nvidia") {
            continue;
        }
        if gpus.iter().any(|g| g.name == name) {
            continue;
        }
        gpus.push(GpuInfo {
            name,
            vendor,
            vram_bytes: vram,
        });
    }
    gpus
}

#[cfg(target_os = "windows")]
fn os_gpu_list() -> Vec<(String, Option<u64>)> {
    // AdapterRAM is a 32-bit value, so it caps at 4 GB. Good enough for non-NVIDIA cards for now.
    let Some(out) = run(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
        ],
    ) else {
        return vec![];
    };
    let value: serde_json::Value = match serde_json::from_str(out.trim()) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items = match value {
        serde_json::Value::Array(a) => a,
        other => vec![other],
    };
    items
        .iter()
        .filter_map(|v| {
            let name = v.get("Name")?.as_str()?.trim().to_string();
            let ram = v.get("AdapterRAM").and_then(|r| r.as_u64()).filter(|r| *r > 0);
            Some((name, ram))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn os_gpu_list() -> Vec<(String, Option<u64>)> {
    run("system_profiler", &["SPDisplaysDataType"])
        .map(|out| {
            out.lines()
                .filter_map(|l| l.trim().strip_prefix("Chipset Model:"))
                .map(|n| (n.trim().to_string(), None))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn os_gpu_list() -> Vec<(String, Option<u64>)> {
    run("lspci", &[])
        .map(|out| {
            out.lines()
                .filter(|l| {
                    l.contains("VGA compatible controller")
                        || l.contains("3D controller")
                        || l.contains("Display controller")
                })
                .filter_map(|l| l.splitn(2, ": ").nth(1))
                .map(|n| (n.trim().to_string(), None))
                .collect()
        })
        .unwrap_or_default()
}
