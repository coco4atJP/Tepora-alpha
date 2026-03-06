use chrono::{DateTime, Days, NaiveDate, Utc};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const FRONTEND_LOG_PREFIX: &str = "frontend-";
const FRONTEND_LOG_SUFFIX: &str = ".log";
const FRONTEND_LOG_RETENTION_DAYS: u64 = 7;

pub fn append_frontend_log(log_dir: &Path, level: &str, message: &str) -> io::Result<()> {
    fs::create_dir_all(log_dir)?;
    prune_old_frontend_logs(log_dir, Utc::now())?;

    let now = Utc::now();
    let file_path = log_file_path_for(log_dir, now.date_naive());
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)?;

    writeln!(
        file,
        "{} [{}] {}",
        now.to_rfc3339(),
        level.to_ascii_uppercase(),
        message
    )?;

    Ok(())
}

pub fn prune_old_frontend_logs(log_dir: &Path, now: DateTime<Utc>) -> io::Result<usize> {
    if !log_dir.exists() {
        return Ok(0);
    }

    let keep_from = retention_start_date(now);
    let mut removed = 0;

    for entry_result in fs::read_dir(log_dir)? {
        let entry = entry_result?;
        if !entry.file_type()?.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };

        let Some(log_date) = parse_frontend_log_date(file_name) else {
            continue;
        };

        if log_date < keep_from {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }

    Ok(removed)
}

fn retention_start_date(now: DateTime<Utc>) -> NaiveDate {
    let keep_days = FRONTEND_LOG_RETENTION_DAYS.saturating_sub(1);
    now.date_naive()
        .checked_sub_days(Days::new(keep_days))
        .unwrap_or_else(|| now.date_naive())
}

fn log_file_path_for(log_dir: &Path, date: NaiveDate) -> PathBuf {
    log_dir.join(format!(
        "{FRONTEND_LOG_PREFIX}{}{FRONTEND_LOG_SUFFIX}",
        date.format("%Y-%m-%d")
    ))
}

fn parse_frontend_log_date(filename: &str) -> Option<NaiveDate> {
    if !filename.starts_with(FRONTEND_LOG_PREFIX) || !filename.ends_with(FRONTEND_LOG_SUFFIX) {
        return None;
    }

    let start = FRONTEND_LOG_PREFIX.len();
    let end = filename.len().saturating_sub(FRONTEND_LOG_SUFFIX.len());
    let date_part = &filename[start..end];
    NaiveDate::parse_from_str(date_part, "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn append_creates_daily_log_file() {
        let temp = tempdir().expect("temp dir");
        append_frontend_log(temp.path(), "warn", "frontend warning").expect("append log");

        let mut created = Vec::new();
        for entry in fs::read_dir(temp.path()).expect("read dir") {
            let entry = entry.expect("dir entry");
            created.push(entry.file_name().to_string_lossy().to_string());
        }

        assert_eq!(created.len(), 1);
        assert!(created[0].starts_with("frontend-"));
        assert!(created[0].ends_with(".log"));

        let content = fs::read_to_string(temp.path().join(&created[0])).expect("read log");
        assert!(content.contains("[WARN] frontend warning"));
    }

    #[test]
    fn prune_removes_only_logs_older_than_retention_window() {
        let temp = tempdir().expect("temp dir");
        let now = Utc::now();
        let keep_from = retention_start_date(now);

        let stale = keep_from
            .checked_sub_days(Days::new(1))
            .expect("stale date");
        let retained = keep_from;

        let stale_path = log_file_path_for(temp.path(), stale);
        let retained_path = log_file_path_for(temp.path(), retained);
        File::create(&stale_path).expect("create stale");
        File::create(&retained_path).expect("create retained");

        let removed = prune_old_frontend_logs(temp.path(), now).expect("prune");
        assert_eq!(removed, 1);
        assert!(!stale_path.exists());
        assert!(retained_path.exists());
    }

    #[test]
    fn prune_ignores_non_frontend_logs() {
        let temp = tempdir().expect("temp dir");
        let unrelated = temp.path().join("app.log");
        File::create(&unrelated).expect("create unrelated");

        let removed = prune_old_frontend_logs(temp.path(), Utc::now()).expect("prune");
        assert_eq!(removed, 0);
        assert!(unrelated.exists());
    }
}
