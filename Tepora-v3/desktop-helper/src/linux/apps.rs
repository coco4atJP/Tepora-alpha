//! Opening apps by name on Linux: installed .desktop entries only (never an arbitrary command line).
use crate::protocol::{HelperError, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub exec: String,
}

/// Name=, Exec= and visibility of a [Desktop Entry] group.
pub fn parse_entry(id: &str, path: &Path, text: &str) -> Option<Entry> {
    let (mut in_group, mut name, mut exec, mut hidden, mut app) = (false, String::new(), String::new(), false, true);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "Name" => name = v.trim().to_owned(),
                "Exec" => exec = v.trim().to_owned(),
                "Hidden" | "NoDisplay" if v.trim() == "true" => hidden = true,
                "Type" => app = v.trim() == "Application",
                _ => {}
            }
        }
    }
    (app && !hidden && !exec.is_empty()).then(|| Entry { id: id.to_owned(), name, path: path.to_owned(), exec })
}

pub fn data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(d) if !d.is_empty() => dirs.push(PathBuf::from(d)),
        _ => {
            if let Ok(h) = std::env::var("HOME") {
                dirs.push(Path::new(&h).join(".local/share"));
            }
        }
    }
    let sys = std::env::var("XDG_DATA_DIRS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(sys.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    dirs
}

pub fn entries(dirs: &[PathBuf]) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d.join("applications")) else { continue };
        for f in rd.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_owned();
            if out.iter().any(|e| e.id == id) {
                continue;
            }
            if let Some(e) = std::fs::read_to_string(&path).ok().and_then(|t| parse_entry(&id, &path, &t)) {
                out.push(e);
            }
        }
    }
    out
}

/// The entry for an app name: exact id or name first, then the last id segment (org.gnome.Calculator ->
/// calculator), then a name that contains it.
pub fn find<'a>(list: &'a [Entry], wanted: &str) -> Option<&'a Entry> {
    let w = wanted.trim().trim_end_matches(".desktop").to_lowercase();
    if w.is_empty() {
        return None;
    }
    let last = |e: &Entry| e.id.rsplit('.').next().unwrap_or("").to_lowercase();
    list.iter()
        .find(|e| e.id.to_lowercase() == w || e.name.to_lowercase() == w)
        .or_else(|| list.iter().find(|e| last(e) == w))
        .or_else(|| list.iter().find(|e| e.name.to_lowercase().contains(&w)))
}

/// Exec= without field codes, split like the Desktop Entry spec's quoting rules (no shell).
pub fn exec_argv(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut any) = (false, false);
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            '%' => match chars.next() {
                Some('%') => cur.push('%'),
                _ => {}
            },
            c if c.is_whitespace() && !quoted => {
                if any || !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                }
                any = false;
            }
            c => {
                cur.push(c);
            }
        }
    }
    if any || !cur.is_empty() {
        args.push(cur);
    }
    args.into_iter().filter(|a| !a.is_empty()).collect()
}

pub fn is_url(what: &str) -> bool {
    let w = what.to_ascii_lowercase();
    w.starts_with("http://") || w.starts_with("https://")
}

fn spawn(program: &str, args: &[String]) -> Result<()> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            std::thread::spawn(move || child.wait());
        })
        .map_err(|e| HelperError::new(format!("Could not start {program}: {e}")))
}

pub fn open(what: &str) -> Result<()> {
    if what.contains("://") || what.starts_with("mailto:") {
        if !is_url(what) {
            return Err(HelperError::new("Only http and https URLs can be opened."));
        }
        return spawn("xdg-open", &[what.to_owned()]);
    }
    let list = entries(&data_dirs());
    let entry = find(&list, what).ok_or_else(|| HelperError::new(format!("No installed app named \"{what}\" (no matching .desktop entry).")))?;
    let argv = exec_argv(&entry.exec);
    let (program, args) = argv.split_first().ok_or_else(|| HelperError::new(format!("{} has no command to start.", entry.name)))?;
    spawn(program, args)
}
