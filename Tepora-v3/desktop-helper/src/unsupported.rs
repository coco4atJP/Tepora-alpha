//! Platforms without a desktop backend in this helper (macOS uses ax-helper.swift).
use crate::keys::Combo;
use crate::protocol::{Backend, HelperError, Result, Shot, WindowInfo};
use serde_json::{json, Value};

pub struct Unsupported;
fn no<T>() -> Result<T> {
    Err(HelperError::new("Desktop apps cannot be operated on this operating system by this helper."))
}
impl Backend for Unsupported {
    fn status(&mut self) -> Value {
        json!({"backend": "unsupported", "accessibility": false, "input": false, "capture": false, "needsPortal": false})
    }
    fn windows(&mut self) -> Result<Vec<WindowInfo>> { no() }
    fn observe(&mut self, _: u32, _: &str, _: usize) -> Result<Value> { no() }
    fn value(&mut self, _: u32, _: &str) -> Result<Option<String>> { no() }
    fn press(&mut self, _: u32, _: &str) -> Result<()> { no() }
    fn click(&mut self, _: u32, _: f64, _: f64, _: &str) -> Result<()> { no() }
    fn set_text(&mut self, _: u32, _: &str, _: &str) -> Result<()> { no() }
    fn type_text(&mut self, _: u32, _: &str) -> Result<()> { no() }
    fn choose(&mut self, _: u32, _: &str, _: &str) -> Result<()> { no() }
    fn key(&mut self, _: u32, _: &Combo) -> Result<()> { no() }
    fn scroll(&mut self, _: u32, _: &str, _: i64) -> Result<()> { no() }
    fn screenshot(&mut self, _: u32, _: &str) -> Result<Shot> { no() }
    fn open(&mut self, _: &str) -> Result<()> { no() }
}
