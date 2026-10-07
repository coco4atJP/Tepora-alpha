use crate::ApiError;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
pub trait InstallerLauncher {
    fn spawn(&self, program: &str, args: &[String]) -> Result<(), ApiError>;
}
struct SystemLauncher;
impl InstallerLauncher for SystemLauncher {
    fn spawn(&self, program: &str, args: &[String]) -> Result<(), ApiError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        // Opening is acknowledged at successful spawn, exactly as the source.
        // Reap asynchronously without holding a request open or killing the UI.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}
pub fn open_installer_page() -> Result<Value, ApiError> {
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    open_installer_page_with(platform, &SystemLauncher)
}
pub fn open_installer_page_with(
    platform: &str,
    launcher: &dyn InstallerLauncher,
) -> Result<Value, ApiError> {
    let (program, args) = super::installer_command(platform);
    launcher.spawn(&program, &args)?;
    Ok(
        json!({"opened":true,"note":"公式の導入ページを開きました。導入後、この画面でAIをもう一度探してください。"}),
    )
}
pub fn memory_gib() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        return text
            .lines()
            .find_map(|line| {
                line.strip_prefix("MemTotal:")
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .map(|kb| kb * 1024 / (1 << 30));
    }
    #[cfg(target_os = "macos")]
    {
        let mut bytes = 0u64;
        let mut len = std::mem::size_of_val(&bytes);
        let rc = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut bytes as *mut u64).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        return (rc == 0).then_some(bytes / (1 << 30));
    }
    #[cfg(windows)]
    {
        #[repr(C)]
        struct MemoryStatus {
            length: u32,
            load: u32,
            values: [u64; 7],
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
        }
        let mut status = MemoryStatus {
            length: std::mem::size_of::<MemoryStatus>() as u32,
            load: 0,
            values: [0; 7],
        };
        return (unsafe { GlobalMemoryStatusEx(&mut status) } != 0)
            .then_some(status.values[0] / (1 << 30));
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        None
    }
}
