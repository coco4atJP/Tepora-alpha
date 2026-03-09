use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug)]
struct LayerRule {
    layer_dir: &'static str,
    forbidden_modules: &'static [&'static str],
}

#[derive(Debug)]
struct Violation {
    file: PathBuf,
    line_number: usize,
    imported_module: &'static str,
    line: String,
}

#[test]
fn layered_backend_modules_do_not_import_forbidden_layers() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src_dir = manifest_dir.join("src");
    let rules = [
        LayerRule {
            layer_dir: "domain",
            forbidden_modules: &["application", "infrastructure", "server"],
        },
        LayerRule {
            layer_dir: "application",
            forbidden_modules: &["infrastructure", "server"],
        },
        LayerRule {
            layer_dir: "infrastructure",
            forbidden_modules: &["application", "server"],
        },
    ];

    let mut violations = Vec::new();
    for rule in rules {
        violations.extend(find_violations(&src_dir, &manifest_dir, rule));
    }

    assert!(
        violations.is_empty(),
        "layer conformance violations detected:\n{}",
        format_violations(&violations)
    );
}

fn find_violations(src_dir: &Path, manifest_dir: &Path, rule: LayerRule) -> Vec<Violation> {
    let layer_root = src_dir.join(rule.layer_dir);
    assert!(
        layer_root.exists(),
        "missing layer directory: {}",
        layer_root.display()
    );

    let mut violations = Vec::new();
    for file in collect_rust_files(&layer_root) {
        let contents = fs::read_to_string(&file)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", file.display()));
        for (index, line) in contents.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || !is_use_line(trimmed) {
                continue;
            }

            for forbidden in rule.forbidden_modules {
                if imports_forbidden_module(trimmed, forbidden) {
                    violations.push(Violation {
                        file: file
                            .strip_prefix(manifest_dir)
                            .unwrap_or(&file)
                            .to_path_buf(),
                        line_number: index + 1,
                        imported_module: forbidden,
                        line: trimmed.to_string(),
                    });
                }
            }
        }
    }

    violations
}

fn collect_rust_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_rust_files_recursive(root, &mut files);
    files.sort();
    files
}

fn collect_rust_files_recursive(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root)
        .unwrap_or_else(|error| panic!("failed to list {}: {error}", root.display()))
    {
        let entry = entry.expect("failed to read directory entry");
        let path = entry.path();
        if path.is_dir() {
            collect_rust_files_recursive(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

fn is_use_line(line: &str) -> bool {
    line.starts_with("use ") || line.starts_with("pub use ")
}

fn imports_forbidden_module(line: &str, module: &str) -> bool {
    line.contains(&format!("crate::{module}::")) || line.contains(&format!("crate::{module};"))
}

fn format_violations(violations: &[Violation]) -> String {
    violations
        .iter()
        .map(|violation| {
            format!(
                "- {}:{} imports forbidden module `{}` via `{}`",
                violation.file.display(),
                violation.line_number,
                violation.imported_module,
                violation.line
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
