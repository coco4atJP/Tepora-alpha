//! Read-only OS facts for the ordinary doctor response. CPU selector semantics
//! depend on the platform/libc; these are not a model/GPU health check.
use serde_json::{json, Value};
use std::{env, io};

trait FactSource {
    fn memory_bytes(&self) -> io::Result<u64>;
    fn logical_cpus(&self) -> io::Result<u64>;
}

pub(super) fn system_facts() -> Value {
    collect(env::consts::OS, env::consts::ARCH, &HostFacts)
}

fn collect(os: &str, arch: &str, source: &impl FactSource) -> Value {
    let platform = match os {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    // Preserve the native unknown-RAM marker rather than inventing a capacity.
    // Node's os.cpus() returns an empty list when CPU facts are unavailable.
    let memory = source.memory_bytes().ok().filter(|bytes| *bytes > 0);
    let cpus = source.logical_cpus().unwrap_or(0);
    json!({"platform":platform,"arch":arch,"ramBytes":memory,"cpuThreads":cpus})
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn positive(value: i64) -> io::Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| io::Error::other("System fact is unavailable"))
}

#[cfg(any(target_os = "linux", test))]
fn paged_memory(pages: i64, page_size: i64) -> io::Result<u64> {
    positive(pages)?
        .checked_mul(positive(page_size)?)
        .ok_or_else(|| io::Error::other("System memory size overflow"))
}

#[cfg(any(target_os = "macos", test))]
fn sized_memory(status: i32, length: usize, bytes: u64) -> io::Result<u64> {
    if status == 0 && length == std::mem::size_of::<u64>() {
        Ok(bytes)
    } else {
        Err(io::Error::other("System memory size is unavailable"))
    }
}

struct HostFacts;

#[cfg(target_os = "linux")]
impl FactSource for HostFacts {
    fn memory_bytes(&self) -> io::Result<u64> {
        // SAFETY: sysconf takes constant selectors and no pointers.
        let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        paged_memory(pages as i64, page_size as i64)
    }

    fn logical_cpus(&self) -> io::Result<u64> {
        // On the verified GNU/Linux host, this reports online logical CPUs
        // rather than the process affinity/quota budget. Other libc variants
        // (notably musl) can have affinity-sensitive selector semantics.
        // SAFETY: sysconf takes a constant selector and no pointers.
        positive(unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) } as i64)
    }
}

#[cfg(target_os = "macos")]
impl FactSource for HostFacts {
    fn memory_bytes(&self) -> io::Result<u64> {
        let mut bytes = 0u64;
        let mut length = std::mem::size_of_val(&bytes);
        // SAFETY: the name is NUL-terminated; the writable output is an aligned
        // u64 with its exact buffer size. A null newp makes this read-only.
        let status = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut bytes as *mut u64).cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        sized_memory(status, length, bytes)
    }

    fn logical_cpus(&self) -> io::Result<u64> {
        // Darwin implements this selector using CTL_HW/HW_NCPU.
        // SAFETY: sysconf takes a constant selector and no pointers.
        positive(unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) } as i64)
    }
}

#[cfg(windows)]
impl FactSource for HostFacts {
    fn memory_bytes(&self) -> io::Result<u64> {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: this C record contains only integer fields; zero is valid.
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of_val(&status) as u32;
        // SAFETY: dwLength describes the valid, writable status buffer.
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(status.ullTotalPhys)
    }

    fn logical_cpus(&self) -> io::Result<u64> {
        use windows_sys::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
        // Use the same processor-group scope as Node/libuv's os.cpus().
        // SAFETY: zero initializes this C record and its pointer fields. The
        // API writes the record synchronously; no pointer is dereferenced here.
        let mut info: SYSTEM_INFO = unsafe { std::mem::zeroed() };
        unsafe { GetSystemInfo(&mut info) };
        Ok(u64::from(info.dwNumberOfProcessors))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl FactSource for HostFacts {
    fn memory_bytes(&self) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported host",
        ))
    }

    fn logical_cpus(&self) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported host",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fixture {
        memory: Option<u64>,
        cpus: Option<u64>,
        reads: Cell<usize>,
    }

    impl FactSource for Fixture {
        fn memory_bytes(&self) -> io::Result<u64> {
            self.reads.set(self.reads.get() + 1);
            self.memory
                .ok_or_else(|| io::Error::other("injected memory failure"))
        }

        fn logical_cpus(&self) -> io::Result<u64> {
            self.reads.set(self.reads.get() + 1);
            self.cpus
                .ok_or_else(|| io::Error::other("injected CPU failure"))
        }
    }

    fn fixture(memory: Option<u64>, cpus: Option<u64>) -> Fixture {
        Fixture {
            memory,
            cpus,
            reads: Cell::new(0),
        }
    }

    #[test]
    fn injected_platforms_use_source_names_and_host_totals() {
        for (os, arch, platform, expected_arch) in [
            ("linux", "x86_64", "linux", "x64"),
            ("linux", "aarch64", "linux", "arm64"),
            ("windows", "x86_64", "win32", "x64"),
            ("windows", "x86", "win32", "ia32"),
            ("windows", "aarch64", "win32", "arm64"),
            ("macos", "aarch64", "darwin", "arm64"),
            ("macos", "x86_64", "darwin", "x64"),
            ("freebsd", "riscv64", "freebsd", "riscv64"),
        ] {
            let source = fixture(Some(64 << 30), Some(192));
            assert_eq!(
                collect(os, arch, &source),
                json!({
                    "platform":platform,"arch":expected_arch,"ramBytes":64u64<<30,"cpuThreads":192
                })
            );
            assert_eq!(source.reads.get(), 2);
        }
    }

    #[test]
    fn injected_zero_and_errors_do_not_fabricate_capacity_or_one_cpu() {
        for value in [Some(0), None] {
            let facts = collect("linux", "x86_64", &fixture(value, value));
            assert_eq!(facts["ramBytes"], Value::Null);
            assert_eq!(facts["cpuThreads"], 0);
            assert_eq!(facts.as_object().unwrap().len(), 4);
        }
        assert_eq!(
            collect("macos", "aarch64", &fixture(None, Some(8)))["cpuThreads"],
            8
        );
        assert_eq!(
            collect("windows", "x86_64", &fixture(Some(16 << 30), None))["ramBytes"],
            16u64 << 30
        );
    }

    #[test]
    fn injected_paged_memory_rejects_failures_zero_and_overflow() {
        assert_eq!(paged_memory(4_194_304, 4096).unwrap(), 16u64 << 30);
        for (pages, size) in [(0, 4096), (-1, 4096), (1, 0), (1, -1), (i64::MAX, 4096)] {
            assert!(paged_memory(pages, size).is_err());
        }
        assert_eq!(positive(192).unwrap(), 192);
        assert!(positive(0).is_err());
        assert!(positive(-1).is_err());
    }

    #[test]
    fn injected_sysctl_memory_requires_success_and_exact_output_size() {
        assert_eq!(sized_memory(0, 8, 32 << 30).unwrap(), 32u64 << 30);
        assert!(sized_memory(-1, 8, 32 << 30).is_err());
        assert!(sized_memory(0, 4, 32 << 30).is_err());
        assert!(sized_memory(0, 16, 32 << 30).is_err());
        assert_eq!(sized_memory(0, 8, 0).unwrap(), 0);
    }
}
