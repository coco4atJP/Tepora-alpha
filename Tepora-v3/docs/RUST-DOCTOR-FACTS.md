# Native ordinary doctor system facts

Release: **3.0.0-beta.11**. Scope: the `platform`, `arch`, `ramBytes` and
`cpuThreads` fields of R090, `GET /api/doctor`, in both explicit native modes.
Normal Node/Tauri startup and the GUI are unchanged.

## Contract

The compatibility host returns `process.platform`, `process.arch`,
`os.totalmem()` and `os.cpus().length`. The native implementation is in
`native-service/src/workspace/doctor.rs` and uses only read-only host APIs:

- Linux: physical-page count × page size, with checked positive arithmetic;
  online logical CPU count from `sysconf(_SC_NPROCESSORS_ONLN)`
- macOS: `hw.memsize` through `sysctlbyname`, requiring successful status and
  the exact output size; logical CPU count through Darwin's `sysconf`
- Windows: `GlobalMemoryStatusEx().ullTotalPhys` and
  `GetSystemInfo().dwNumberOfProcessors`, using the existing `windows-sys`
  dependency with its SystemInformation feature

Logical CPU inventory no longer uses Rust's `available_parallelism`, which
can reflect process affinity or quotas. Windows retains the processor-group
scope used by Node/libuv's CPU inventory, rather than switching to an all-group
count. These are diagnostic facts, not a measurement of usable model capacity.
The Linux backend inherits its libc's selector semantics: the live comparison
here covers GNU/Linux only. Musl and other libc variants remain unverified
and may report an affinity-sensitive CPU count; all-Linux independence from
affinity is not claimed.

Platform names map Windows → `win32` and macOS → `darwin`. Architecture names
map `x86_64` → `x64`, `aarch64` → `arm64` and `x86` → `ia32`.

CPU lookup failure returns `0`, corresponding to the source's empty CPU list;
it no longer invents a one-CPU result. Zero/failed RAM lookup keeps the existing
native `null` marker, an explicit difference from the source's zero result.
Unsupported platforms report unknown RAM and zero CPUs. No diagnostic error
text, hardware serial, account data or additional host details are returned.

The existing `nativeDevelopment: true` field and Japanese development note
are retained verbatim. Provider and sandbox projections are unchanged. This
bounded slice does not establish full doctor-response parity, particularly
nonempty/live provider-limit projection or obscure OS API failure behavior.
R090 therefore remains **partial**, and inventory totals remain **94
implemented / 12 partial / 20 unavailable**, plus 22 static rows. Real model
and GPU checks are not part of either host's doctor response.

## Focused verification

`workspace::doctor::tests` injects the fact source to verify supported
OS/architecture spellings, a 64 GiB/192 CPU fixture, zero and failed independent
lookups, positive page conversion, negative values, multiplication overflow,
and successful/error/truncated sysctl outputs. The same tests run on all
platforms; they do not claim to execute another OS's FFI.

`tests/native-doctor-facts.test.mjs` starts the real compatibility host and
both native development modes with isolated data. Native processes have an
empty executable search path. Authenticated GET responses are compared with
Node's current host facts, including non-null RAM and logical CPU count.
The test also checks the deliberate native marker/note, data/workspace paths,
empty provider projection, stable repeated reads and clean shutdown.

Local GNU/Linux validation on 2026-10-08 passed the 4 focused Rust tests,
the core/native builds, and 6 focused Node checks on each of Node 22.16.0 and
24.19.0 (1 real HTTP comparison plus 5 route-inventory checks). All three host
modes reported 10,475,839,488 RAM bytes and 9 logical CPUs. The local available
parallelism was also 9; no live affinity-restriction experiment is claimed.
Syntax checks passed for 245 JavaScript modules, and affected relative document
links and diff whitespace checks passed. These are focused results only.

The existing Windows/macOS CI matrices will execute the platform-specific
implementations and the real HTTP comparison. A configured matrix is not a
successful run; exact-head execution and packaging remain pending until their
actual results are recorded. No shell command is used to collect facts. No
real provider/model, GPU, browser, external account or held policy/security
probe is exercised by this focused gate; it is not a full quality pass.

## Platform references

- [Node 22 OS interface](https://github.com/nodejs/node/blob/v22.16.0/lib/os.js)
- [libuv Windows facts](https://github.com/libuv/libuv/blob/v1.51.0/src/win/util.c)
- [Apple sysconf implementation](https://github.com/apple-oss-distributions/Libc/blob/main/gen/FreeBSD/sysconf.c)
- [GlobalMemoryStatusEx](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-globalmemorystatusex)
- [GetSystemInfo](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsysteminfo)
