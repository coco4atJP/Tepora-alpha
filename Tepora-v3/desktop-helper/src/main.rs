//! tepora-desktop-helper: desktop control for Windows (UI Automation + SendInput) and Linux X11 (AT-SPI2 +
//! XTest), speaking the same JSON-lines protocol as the macOS ax-helper.swift
//! (core/computer/desktop-contract.json). `--version` and `--contract` print and exit.
mod contract;
mod image;
mod keys;
mod protocol;
mod win_map;
#[cfg(test)]
mod tests;
#[cfg(not(any(windows, target_os = "linux")))]
mod unsupported;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

use std::io::{BufRead, Write};

fn backend() -> Box<dyn protocol::Backend> {
    #[cfg(target_os = "linux")]
    return Box::new(linux::LinuxBackend::new());
    #[cfg(windows)]
    return Box::new(windows::WindowsBackend::new());
    #[cfg(not(any(windows, target_os = "linux")))]
    return Box::new(unsupported::Unsupported);
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => return println!("tepora-desktop-helper {}", env!("CARGO_PKG_VERSION")),
        Some("--contract") => return println!("{}", contract::Contract::get().commands.join(" ")),
        _ => {}
    }
    let mut backend = backend();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if let Some(reply) = protocol::handle_line(backend.as_mut(), &line) {
            if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    }
}
