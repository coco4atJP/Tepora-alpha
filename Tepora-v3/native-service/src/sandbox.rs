//! Source-backed command confinement plans. Selecting a sandbox is a request to
//! use it, never permission to fall back to an unrestricted child process.
use crate::ApiError;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
};
use tepora_core::json_codec::{encode_text, sql_text};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Macos,
    Windows,
    Other(String),
}
impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other(env::consts::OS.into())
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::Linux => "linux",
            Self::Macos => "darwin",
            Self::Windows => "win32",
            Self::Other(s) => s,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMode {
    Off,
    Workspace,
    Readonly,
    Container,
}
impl SandboxMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Workspace => "workspace",
            Self::Readonly => "readonly",
            Self::Container => "container",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxConfig {
    pub mode: SandboxMode,
    pub network: bool,
    /// Internal JSON codec strings. Conversion happens only at the OS boundary.
    pub writable: Vec<String>,
    pub image: String,
    pub engine: String,
}
impl Default for SandboxConfig {
    fn default() -> Self {
        Self {
            mode: SandboxMode::Off,
            network: true,
            writable: vec![],
            image: "node:22-bookworm-slim".into(),
            engine: "auto".into(),
        }
    }
}
impl SandboxConfig {
    pub fn parse(
        raw: &Value,
        previous: Option<&Self>,
        platform: &Platform,
    ) -> Result<Self, ApiError> {
        let empty = serde_json::Map::new();
        // Source Object.keys([]) is empty; nonempty arrays have unknown keys.
        let raw = raw
            .as_object()
            .or_else(|| raw.as_array().filter(|a| a.is_empty()).map(|_| &empty))
            .ok_or_else(|| ApiError::bad_request("Invalid sandbox settings"))?;
        if !raw.keys().all(|k| {
            matches!(
                k.as_str(),
                "mode" | "network" | "writable" | "image" | "engine"
            )
        }) {
            return Err(ApiError::bad_request("Invalid sandbox settings"));
        }
        let mut config = previous.cloned().unwrap_or_default();
        if let Some(value) = raw.get("mode") {
            config.mode = match value.as_str() {
                Some("off") => SandboxMode::Off,
                Some("workspace") => SandboxMode::Workspace,
                Some("readonly") => SandboxMode::Readonly,
                Some("container") => SandboxMode::Container,
                _ => return Err(ApiError::bad_request("Unknown sandbox mode")),
            };
        }
        if let Some(value) = raw.get("network") {
            config.network = value
                .as_bool()
                .ok_or_else(|| ApiError::bad_request("Invalid sandbox network"))?;
        }
        if let Some(value) = raw.get("writable") {
            let values = value
                .as_array()
                .filter(|a| a.len() <= 16)
                .ok_or_else(|| ApiError::bad_request("Writable paths must be absolute"))?;
            let mut paths = vec![];
            for value in values {
                let path = value
                    .as_str()
                    .filter(|p| is_absolute(platform, &sql_text(p)))
                    .ok_or_else(|| ApiError::bad_request("Writable paths must be absolute"))?;
                if !paths.iter().any(|p| p == path) {
                    paths.push(path.into());
                }
            }
            config.writable = paths;
        }
        if let Some(value) = raw.get("image") {
            config.image = value
                .as_str()
                .filter(|s| {
                    (1..=300).contains(&s.len())
                        && s.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_./:@-".contains(&c))
                })
                .ok_or_else(|| ApiError::bad_request("Invalid container image"))?
                .into();
        }
        if let Some(value) = raw.get("engine") {
            config.engine = value
                .as_str()
                .filter(|s| matches!(*s, "auto" | "docker" | "podman"))
                .ok_or_else(|| ApiError::bad_request("Invalid container engine"))?
                .into();
        }
        Ok(config)
    }
    pub fn value(&self) -> Value {
        json!({"mode":self.mode.as_str(),"network":self.network,"writable":self.writable,"image":self.image,"engine":self.engine})
    }
}
fn is_absolute(platform: &Platform, path: &str) -> bool {
    if *platform == Platform::Windows {
        path.starts_with('/')
            || path.starts_with('\\')
            || (path.len() >= 3
                && path.as_bytes()[0].is_ascii_alphabetic()
                && path.as_bytes()[1] == b':'
                && matches!(path.as_bytes()[2], b'/' | b'\\'))
    } else {
        path.starts_with('/')
    }
}
#[derive(Clone, Debug)]
pub struct Shell {
    pub file: PathBuf,
    pub name: String,
    pub windows: bool,
}
impl Shell {
    pub fn command_args(&self, command: &str) -> Vec<OsString> {
        let mut args = if self.windows {
            vec!["/d".into(), "/s".into(), "/c".into()]
        } else {
            vec!["-c".into()]
        };
        args.push(sql_text(command).into());
        args
    }
    pub fn detect(platform: &Platform) -> Self {
        if *platform == Platform::Windows {
            return Self {
                file: env::var_os("ComSpec")
                    .unwrap_or_else(|| "cmd.exe".into())
                    .into(),
                name: "cmd".into(),
                windows: true,
            };
        }
        let file = env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let name = encode_text(
            &file
                .file_name()
                .unwrap_or_else(|| OsStr::new("sh"))
                .to_string_lossy(),
        );
        Self {
            file,
            name,
            windows: false,
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Available {
    pub seatbelt: bool,
    pub bwrap: Option<PathBuf>,
    pub docker: Option<PathBuf>,
    pub podman: Option<PathBuf>,
}
impl Available {
    pub fn detect(platform: &Platform, path: &OsStr) -> Self {
        Self {
            seatbelt: *platform == Platform::Macos && Path::new("/usr/bin/sandbox-exec").exists(),
            bwrap: if *platform == Platform::Linux {
                which("bwrap", path, platform)
            } else {
                None
            },
            docker: which("docker", path, platform),
            podman: which("podman", path, platform),
        }
    }
    pub fn value(&self, platform: &Platform) -> Value {
        json!({"platform":platform.name(),"seatbelt":self.seatbelt,"bwrap":self.bwrap.as_ref().map(|p|encode_path(p)),"docker":self.docker.as_ref().map(|p|encode_path(p)),"podman":self.podman.as_ref().map(|p|encode_path(p))})
    }
}
pub fn which(name: &str, path: &OsStr, platform: &Platform) -> Option<PathBuf> {
    let extensions = if *platform == Platform::Windows {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    for dir in env::split_paths(path) {
        for extension in &extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if *platform != Platform::Windows
                    && fs::metadata(&candidate).ok()?.permissions().mode() & 0o111 == 0
                {
                    continue;
                }
            }
            return Some(candidate);
        }
    }
    None
}
#[derive(Clone, Debug)]
pub struct SpawnFacts {
    pub platform: Platform,
    pub shell: Shell,
    pub available: Available,
    pub temp_dir: PathBuf,
}
impl SpawnFacts {
    pub fn capture() -> Self {
        let platform = Platform::current();
        let shell = Shell::detect(&platform);
        let available = Available::detect(&platform, &env::var_os("PATH").unwrap_or_default());
        Self {
            platform,
            shell,
            available,
            temp_dir: env::temp_dir(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct SpawnPlan {
    pub file: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub sandbox: String,
    pub container: Option<String>,
}
impl SpawnPlan {
    pub fn value(&self) -> Value {
        let mut value = json!({"file":encode_path(&self.file),"args":self.args.iter().map(|s|encode_text(&s.to_string_lossy())).collect::<Vec<_>>(),"cwd":encode_path(&self.cwd),"sandbox":self.sandbox});
        if let Some(name) = &self.container {
            value["container"] = json!(name);
        }
        value
    }
    pub fn is_container(&self) -> bool {
        matches!(self.sandbox.as_str(), "docker" | "podman")
    }
}
pub fn absolute(path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}
fn real(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| absolute(path))
}
pub fn writable_roots(
    policy: &SandboxConfig,
    cwd: &Path,
    facts: &SpawnFacts,
) -> Option<Vec<PathBuf>> {
    writable_roots_with_resolver(policy, cwd, facts, &real)
}
fn writable_roots_with_resolver(
    policy: &SandboxConfig,
    cwd: &Path,
    facts: &SpawnFacts,
    resolve: &dyn Fn(&Path) -> PathBuf,
) -> Option<Vec<PathBuf>> {
    if policy.mode == SandboxMode::Off {
        return None;
    }
    let mut roots = vec![
        resolve(&facts.temp_dir),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
    ];
    if policy.mode != SandboxMode::Readonly && !cwd.as_os_str().is_empty() {
        roots.push(resolve(cwd));
    }
    roots.extend(
        policy
            .writable
            .iter()
            .map(|p| resolve(Path::new(&sql_text(p)))),
    );
    let mut seen = HashSet::new();
    roots.retain(|p| seen.insert(p.clone()));
    Some(roots)
}
fn seatbelt_quote(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}
pub fn seatbelt_profile(policy: &SandboxConfig, cwd: &Path, facts: &SpawnFacts) -> String {
    seatbelt_profile_with_resolver(policy, cwd, facts, &real)
}
fn seatbelt_profile_with_resolver(
    policy: &SandboxConfig,
    cwd: &Path,
    facts: &SpawnFacts,
    resolve: &dyn Fn(&Path) -> PathBuf,
) -> String {
    let roots = writable_roots_with_resolver(policy, cwd, facts, resolve).unwrap_or_default();
    let mut lines=vec!["(version 1)".into(),"(allow default)".into(),"(deny file-write*)".into(),format!("(allow file-write* {} (subpath \"/private/var/folders\") (literal \"/dev/null\") (literal \"/dev/zero\") (regex #\"^/dev/tty\") (regex #\"^/dev/fd/\") (literal \"/dev/stdout\") (literal \"/dev/stderr\"))",roots.iter().map(|r|format!("(subpath {})",seatbelt_quote(r))).collect::<Vec<_>>().join(" "))];
    if !policy.network {
        lines.push("(deny network-outbound)".into());
        lines.push("(allow network-outbound (remote unix-socket))".into());
    }
    lines.join("\n")
}
pub fn wrap_command(
    command: &str,
    cwd: &Path,
    policy: &SandboxConfig,
    container_name: Option<&str>,
    facts: &SpawnFacts,
) -> Result<SpawnPlan, ApiError> {
    wrap_command_with_resolver(command, cwd, policy, container_name, facts, &real)
}
// Synthetic platform fixtures must resolve paths independently of the host OS.
// Actual execution always enters through wrap_command and retains realpath semantics.
pub(crate) fn wrap_command_with_resolver(
    command: &str,
    cwd: &Path,
    policy: &SandboxConfig,
    container_name: Option<&str>,
    facts: &SpawnFacts,
    resolve: &dyn Fn(&Path) -> PathBuf,
) -> Result<SpawnPlan, ApiError> {
    let plan =
        |file: PathBuf, args: Vec<OsString>, sandbox: &str, container: Option<String>| SpawnPlan {
            file,
            args,
            cwd: cwd.to_path_buf(),
            sandbox: sandbox.into(),
            container,
        };
    if policy.mode == SandboxMode::Off {
        return Ok(plan(
            facts.shell.file.clone(),
            facts.shell.command_args(command),
            "off",
            None,
        ));
    }
    if policy.mode != SandboxMode::Container {
        if facts.available.seatbelt {
            let mut args = vec![
                "-p".into(),
                seatbelt_profile_with_resolver(policy, cwd, facts, resolve).into(),
                facts.shell.file.clone().into_os_string(),
            ];
            args.extend(facts.shell.command_args(command));
            return Ok(plan("/usr/bin/sandbox-exec".into(), args, "seatbelt", None));
        }
        if let Some(bwrap) = &facts.available.bwrap {
            let mut args: Vec<OsString> = [
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
            ]
            .into_iter()
            .map(Into::into)
            .collect();
            if policy.mode != SandboxMode::Readonly {
                for path in std::iter::once(cwd.to_path_buf())
                    .chain(policy.writable.iter().map(|p| PathBuf::from(sql_text(p))))
                {
                    if !path.as_os_str().is_empty() {
                        args.push("--bind".into());
                        args.push(path.clone().into_os_string());
                        args.push(path.into_os_string());
                    }
                }
            }
            if !policy.network {
                args.push("--unshare-net".into());
            }
            args.extend([
                OsString::from("--die-with-parent"),
                "--chdir".into(),
                cwd.as_os_str().to_owned(),
                "/bin/sh".into(),
                "-c".into(),
                sql_text(command).into(),
            ]);
            return Ok(plan(bwrap.clone(), args, "bwrap", None));
        }
    }
    let engine = match policy.engine.as_str() {
        "auto" => facts
            .available
            .docker
            .as_ref()
            .map(|p| ("docker", p))
            .or_else(|| facts.available.podman.as_ref().map(|p| ("podman", p))),
        "docker" => facts.available.docker.as_ref().map(|p| ("docker", p)),
        "podman" => facts.available.podman.as_ref().map(|p| ("podman", p)),
        _ => None,
    };
    let Some((name, file)) = engine else {
        return Err(ApiError::new(
            409,
            if policy.mode == SandboxMode::Container {
                "コンテナ（Docker/Podman）が見つかりません。"
            } else {
                "このOSで使えるサンドボックスがありません。コンテナ（Docker/Podman）を入れるか、サンドボックスをオフにしてください。"
            },
        ));
    };
    let mut args: Vec<OsString> = ["run", "--rm", "-i", "--init"]
        .into_iter()
        .map(Into::into)
        .collect();
    if let Some(name) = container_name {
        args.extend(["--name".into(), name.into()]);
    }
    args.extend([
        "--network".into(),
        if policy.network {
            "bridge".into()
        } else {
            "none".into()
        },
        "-v".into(),
        format!(
            "{}:/workspace{}",
            cwd.to_string_lossy(),
            if policy.mode == SandboxMode::Readonly {
                ":ro"
            } else {
                ""
            }
        )
        .into(),
    ]);
    for path in &policy.writable {
        let path = sql_text(path);
        args.extend(["-v".into(), format!("{path}:{path}").into()]);
    }
    args.extend([
        "-w".into(),
        "/workspace".into(),
        sql_text(&policy.image).into(),
        "sh".into(),
        "-c".into(),
        sql_text(command).into(),
    ]);
    Ok(plan(
        file.clone(),
        args,
        name,
        container_name.map(str::to_owned),
    ))
}
pub fn encode_path(path: &Path) -> String {
    encode_text(&path.to_string_lossy())
}
/// Optional source-compatible PTY adapter. Rust owns and drains the spawned wrapper;
/// ordinary execution does not invoke Python or script.
pub fn with_tty(command: &str, platform: &Platform) -> Result<String, ApiError> {
    if *platform == Platform::Windows {
        return Err(ApiError::new(
            500,
            "A pseudo-terminal is available on macOS and Linux only.",
        ));
    }
    // Python <=3.9 removes the master from select on BSD/macOS's zero-byte
    // terminal EOF, then hangs on our intentionally open interactive stdin.
    // Normalize that EOF to Linux's EIO: both old and new pty.spawn finish their
    // copy loop, close the master, and waitpid their own child. Do not close
    // stdin early or infer child exit from output/silence.
    const PTY: &str = r#"import errno,os,pty,sys
def master_read(fd):
    data=os.read(fd,1024)
    if not data:
        raise OSError(errno.EIO,'PTY EOF')
    return data
sys.exit(os.waitstatus_to_exitcode(pty.spawn(['/bin/sh','-c',sys.argv[1]],master_read=master_read)))"#;
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
    Ok(format!("if command -v python3 >/dev/null 2>&1; then exec python3 -c {} {}; else exec script -qec {} /dev/null; fi",quote(PTY),quote(command),quote(command)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn facts(platform: Platform) -> SpawnFacts {
        SpawnFacts {
            platform,
            shell: Shell {
                file: "/bin/test-shell".into(),
                name: "test-shell".into(),
                windows: false,
            },
            available: Available::default(),
            temp_dir: "/tmp".into(),
        }
    }
    #[test]
    fn defaults_and_normalization_preserve_real_off_policy() {
        let p = SandboxConfig::parse(&json!({}), None, &Platform::Linux).unwrap();
        assert_eq!(p.mode, SandboxMode::Off);
        assert!(p.network);
        assert_eq!(p.image, "node:22-bookworm-slim");
        let p = SandboxConfig::parse(
            &json!({"mode":"readonly","writable":["/a","/a","/b"]}),
            None,
            &Platform::Linux,
        )
        .unwrap();
        assert_eq!(p.writable, vec!["/a", "/b"]);
        for raw in [
            json!({"mode":"protected"}),
            json!({"network":0}),
            json!({"image":"image;evil"}),
            json!({"writable":["relative"]}),
            json!({"extra":true}),
        ] {
            assert!(SandboxConfig::parse(&raw, None, &Platform::Linux).is_err());
        }
    }
    #[test]
    fn explicit_confinement_never_falls_back_to_the_shell() {
        let f = facts(Platform::Linux);
        for mode in [
            SandboxMode::Workspace,
            SandboxMode::Readonly,
            SandboxMode::Container,
        ] {
            let p = SandboxConfig {
                mode,
                ..Default::default()
            };
            assert_eq!(
                wrap_command("echo test", Path::new("/work"), &p, None, &f)
                    .unwrap_err()
                    .status,
                409
            );
        }
        let plan = wrap_command(
            "echo 'literal'",
            Path::new("/work"),
            &SandboxConfig::default(),
            None,
            &f,
        )
        .unwrap();
        assert_eq!(plan.file, Path::new("/bin/test-shell"));
        assert_eq!(plan.value()["args"], json!(["-c", "echo 'literal'"]));
    }
    #[test]
    fn linux_workspace_and_readonly_argv_match_source() {
        let mut f = facts(Platform::Linux);
        f.available.bwrap = Some("/usr/bin/bwrap".into());
        let mut p = SandboxConfig {
            mode: SandboxMode::Workspace,
            network: false,
            writable: vec!["/extra".into()],
            ..Default::default()
        };
        let plan = wrap_command("id", Path::new("/work"), &p, None, &f).unwrap();
        assert_eq!(
            plan.value()["args"],
            json!([
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
                "--bind",
                "/work",
                "/work",
                "--bind",
                "/extra",
                "/extra",
                "--unshare-net",
                "--die-with-parent",
                "--chdir",
                "/work",
                "/bin/sh",
                "-c",
                "id"
            ])
        );
        p.mode = SandboxMode::Readonly;
        assert!(!wrap_command("id", Path::new("/work"), &p, None, &f)
            .unwrap()
            .args
            .iter()
            .any(|a| a == "--bind"));
    }
    #[test]
    fn container_choice_mounts_and_names_are_explicit() {
        let mut f = facts(Platform::Windows);
        f.available.docker = Some("docker.exe".into());
        f.available.podman = Some("podman.exe".into());
        let p = SandboxConfig {
            mode: SandboxMode::Readonly,
            network: false,
            writable: vec!["/extra".into()],
            ..Default::default()
        };
        let plan =
            wrap_command("printf x", Path::new("/work"), &p, Some("tepora-p123"), &f).unwrap();
        assert_eq!(plan.sandbox, "docker");
        assert_eq!(
            plan.value()["args"],
            json!([
                "run",
                "--rm",
                "-i",
                "--init",
                "--name",
                "tepora-p123",
                "--network",
                "none",
                "-v",
                "/work:/workspace:ro",
                "-v",
                "/extra:/extra",
                "-w",
                "/workspace",
                "node:22-bookworm-slim",
                "sh",
                "-c",
                "printf x"
            ])
        );
    }
    #[test]
    fn seatbelt_profile_escapes_paths_and_blocks_only_requested_network() {
        let mut f = facts(Platform::Macos);
        f.available.seatbelt = true;
        let p = SandboxConfig {
            mode: SandboxMode::Workspace,
            network: false,
            writable: vec!["/extra\"quote".into()],
            ..Default::default()
        };
        let plan = wrap_command_with_resolver(
            "echo x",
            Path::new("/work"),
            &p,
            None,
            &f,
            &Path::to_path_buf,
        )
        .unwrap();
        let profile = plan.args[1].to_string_lossy();
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("/extra\\\"quote"));
        assert!(profile.contains("(deny network-outbound)"));
        assert!(profile.contains("(remote unix-socket)"));
        assert_eq!(plan.sandbox, "seatbelt");
    }
    #[cfg(unix)]
    #[test]
    fn runtime_seatbelt_roots_resolve_symlinks_and_keep_missing_path_fallback() {
        let root = env::temp_dir().join(format!("tepora-sandbox-{}", uuid::Uuid::new_v4()));
        for directory in ["temp", "work", "extra"] {
            fs::create_dir_all(root.join("physical").join(directory)).unwrap();
        }
        let alias = root.join("alias");
        std::os::unix::fs::symlink(root.join("physical"), &alias).unwrap();
        let mut f = facts(Platform::Macos);
        f.available.seatbelt = true;
        f.temp_dir = alias.join("temp");
        let cwd = alias.join("work");
        let p = SandboxConfig {
            mode: SandboxMode::Workspace,
            writable: vec![
                encode_path(&alias.join("extra")),
                encode_path(&alias.join("missing/../fallback")),
            ],
            ..Default::default()
        };
        let expected = vec![
            fs::canonicalize(root.join("physical/temp")).unwrap(),
            PathBuf::from("/tmp"),
            PathBuf::from("/private/tmp"),
            fs::canonicalize(root.join("physical/work")).unwrap(),
            fs::canonicalize(root.join("physical/extra")).unwrap(),
            absolute(&alias.join("fallback")),
        ];
        let roots = writable_roots(&p, &cwd, &f).unwrap();
        let profile = seatbelt_profile(&p, &cwd, &f);
        let plan = wrap_command("echo x", &cwd, &p, None, &f).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(roots, expected);
        assert_eq!(plan.args[1], OsString::from(&profile));
        for path in expected {
            assert!(profile.contains(&format!("(subpath {})", seatbelt_quote(&path))));
        }
        assert!(!profile.contains(&format!("(subpath {})", seatbelt_quote(&cwd))));
    }
    #[test]
    fn tty_wrapper_keeps_quotes_and_windows_is_explicit() {
        let command = "printf '%s' \"a'b\"";
        let wrapped = with_tty(command, &Platform::Linux).unwrap();
        assert!(wrapped.contains("command -v python3"));
        assert!(wrapped.contains("exec script -qec"));
        assert!(wrapped.contains("'\\''"));
        assert!(with_tty(command, &Platform::Windows).is_err());
    }
}
