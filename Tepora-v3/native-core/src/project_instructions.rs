//! Bounded, read-only repository instruction discovery shared by both hosts.
//! This module owns no session state. Hosts snapshot the result before inference.
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

const MAX_DEPTH: usize = 64;
const MAX_FILE: usize = 16 * 1024;
const MAX_TOTAL: usize = 32 * 1024;

pub fn load(cwd: &Path) -> String {
    if cwd.as_os_str().is_empty() {
        return String::new();
    }
    let Ok(cwd) = fs::canonicalize(cwd) else {
        return "# Project instructions\nThe working folder is unavailable; repository instructions could not be loaded. Resolve the folder before editing.".into();
    };
    let mut chain = vec![cwd.clone()];
    while !chain.last().unwrap().join(".git").exists() && chain.len() < MAX_DEPTH {
        let Some(parent) = chain.last().unwrap().parent() else {
            break;
        };
        chain.push(parent.to_path_buf());
    }
    if !chain.last().unwrap().join(".git").exists() {
        chain.truncate(1);
    }
    let root = chain.last().unwrap().clone();
    chain.reverse();
    let mut output = format!("# Project instructions\nScope: {:?}. Apply these files in order; deeper instructions take precedence within their directory. User instructions and tool permissions still apply. Before editing outside this working folder or inside a deeper directory, read any additional applicable AGENTS.md files.\n", cwd.display().to_string());
    let mut remaining = MAX_TOTAL;
    let mut found = false;
    for dir in chain {
        for relative in [".agents/AGENTS.md", "AGENTS.md"] {
            let file = dir.join(relative);
            let resolved = match fs::canonicalize(&file) {
                Ok(path) => path,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    output.push_str(&format!(
                        "\nCould not inspect {:?}; read it before editing its scope.\n",
                        file.display().to_string()
                    ));
                    continue;
                }
            };
            found = true;
            output.push_str(&format!("\n## {:?}\n", file.display().to_string()));
            if !resolved.starts_with(&root) {
                output.push_str("Not loaded: this instruction file resolves outside the repository. Inspect it explicitly before relying on it.\n");
                continue;
            }
            let limit = remaining.min(MAX_FILE);
            let mut bytes = Vec::new();
            let read = fs::metadata(&resolved)
                .and_then(|meta| {
                    if !meta.is_file() {
                        return Err(std::io::Error::other("not a regular file"));
                    }
                    File::open(&resolved)
                })
                .and_then(|f| {
                    // Reject directories, devices and FIFOs before trying to read.
                    if !f.metadata()?.is_file() {
                        return Err(std::io::Error::other("not a regular file"));
                    }
                    f.take(limit as u64 + 1).read_to_end(&mut bytes)
                });
            if read.is_err() {
                output.push_str(
                    "Could not read this file. Read it explicitly before editing its scope.\n",
                );
                continue;
            }
            if bytes.len() > limit {
                output.push_str("Not loaded in full: the instruction file exceeds the automatic loading budget (16 KiB per file, 32 KiB total). Read it explicitly before editing its scope.\n");
                continue;
            }
            remaining -= bytes.len();
            match String::from_utf8(bytes) {
                Ok(text) => for line in text.lines() { output.push_str("> "); output.push_str(line); output.push('\n'); },
                Err(_) => output.push_str("Not loaded: this file is not UTF-8. Inspect its encoding before editing its scope.\n"),
            }
        }
    }
    if !found {
        output.push_str("\nNo applicable AGENTS.md files were found in this scope.\n");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "tepora-instructions-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn scopes_to_repository_and_orders_nested_instructions() {
        let f = Fixture::new();
        let repo = f.0.join("repo");
        let nested = repo.join("src/deep");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::create_dir(repo.join(".agents")).unwrap();
        fs::write(f.0.join("AGENTS.md"), "OUTSIDE").unwrap();
        fs::write(repo.join(".agents/AGENTS.md"), "REPOSITORY").unwrap();
        fs::write(repo.join("src/AGENTS.md"), "NESTED").unwrap();
        let text = load(&nested);
        assert!(!text.contains("OUTSIDE"));
        assert!(text.find("> REPOSITORY").unwrap() < text.find("> NESTED").unwrap());
        fs::write(repo.join("src/AGENTS.md"), "UPDATED").unwrap();
        assert!(load(&nested).contains("> UPDATED"));
        fs::remove_file(repo.join("src/AGENTS.md")).unwrap();
        assert!(!load(&nested).contains("> UPDATED"));
    }
    #[test]
    fn no_repository_within_search_bound_stays_in_cwd_and_discloses_large_files() {
        let f = Fixture::new();
        // The host's temp directory may itself be in a repository. Put that
        // ambient marker beyond the documented search bound, without changing it.
        let mut parent=f.0.clone();
        for _ in 0..MAX_DEPTH { parent=parent.join("d"); }
        let cwd = parent.join("project");
        fs::create_dir_all(&cwd).unwrap();
        fs::write(parent.join("AGENTS.md"), "OUTSIDE").unwrap();
        fs::write(cwd.join("AGENTS.md"), "x".repeat(MAX_FILE + 1)).unwrap();
        let text = load(&cwd);
        assert!(!text.contains("OUTSIDE"));
        assert!(text.contains("exceeds the automatic loading budget"));
        assert!(text.len() < 2000);
    }
    #[cfg(unix)]
    #[test]
    fn instruction_symlinks_do_not_escape_repository() {
        let f = Fixture::new();
        let repo = f.0.join("repo");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::write(f.0.join("outside.md"), "OUTSIDE CONTENT").unwrap();
        std::os::unix::fs::symlink(f.0.join("outside.md"), repo.join("AGENTS.md")).unwrap();
        let text = load(&repo);
        assert!(!text.contains("OUTSIDE CONTENT"));
        assert!(text.contains("resolves outside"));
    }
}
