//! The desktop backend contract shared with the macOS helper and the Node side
//! (core/computer/desktop-contract.json): command names and the common role table.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

pub const CONTRACT_JSON: &str = include_str!("../../core/computer/desktop-contract.json");

/// Which native role vocabulary a lookup uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // each OS build uses its own vocabulary; tests use both
pub enum Platform {
    Uia,
    Atspi,
}
impl Platform {
    fn key(self) -> &'static str {
        match self {
            Platform::Uia => "uia",
            Platform::Atspi => "atspi",
        }
    }
}

pub struct Contract {
    pub commands: Vec<String>,
    pub roles: HashSet<String>,
    pub value_roles: HashSet<String>,
    pub toggle_roles: HashSet<String>,
    maps: HashMap<&'static str, HashMap<String, String>>,
    no_press: HashMap<&'static str, HashSet<String>>,
    text: HashMap<&'static str, HashSet<String>>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

impl Contract {
    pub fn parse(json: &str) -> Result<Contract, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("Invalid desktop contract: {e}"))?;
        let mut maps = HashMap::new();
        let mut no_press = HashMap::new();
        let mut text = HashMap::new();
        for key in ["mac", "uia", "atspi"] {
            let table = v[key].as_object().ok_or_else(|| format!("Desktop contract has no {key} role table"))?;
            maps.insert(key, table.iter().filter_map(|(k, r)| r.as_str().map(|r| (k.clone(), r.to_owned()))).collect());
            no_press.insert(key, strings(&v["noPressFallback"][key]).into_iter().collect());
            text.insert(key, strings(&v["textRoles"][key]).into_iter().collect());
        }
        Ok(Contract {
            commands: strings(&v["commands"]),
            roles: strings(&v["roles"]).into_iter().collect(),
            value_roles: strings(&v["valueRoles"]).into_iter().collect(),
            toggle_roles: strings(&v["toggleRoles"]).into_iter().collect(),
            maps,
            no_press,
            text,
        })
    }
    pub fn get() -> &'static Contract {
        static CONTRACT: OnceLock<Contract> = OnceLock::new();
        CONTRACT.get_or_init(|| Contract::parse(CONTRACT_JSON).expect("embedded desktop contract"))
    }
    /// The common role of a native role, the way ax-helper.swift maps AX roles: the table first; otherwise a
    /// control that can be pressed (and is not text, a group or a window) is a button. Images count only when
    /// they can be pressed.
    pub fn role(&self, platform: Platform, native: &str, pressable: bool) -> Option<String> {
        let mapped = self.maps[platform.key()].get(native).cloned();
        let mapped = match mapped {
            Some(r) if r == "image" && !pressable => None,
            Some(r) => Some(r),
            None if pressable && !self.no_press[platform.key()].contains(native) => Some("button".to_owned()),
            None => None,
        };
        mapped.filter(|r| self.roles.contains(r))
    }
    /// Whether being pressable can make this native role a control (it is not excluded from the button fallback).
    #[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
    pub fn press_matters(&self, platform: Platform, native: &str) -> bool {
        !self.no_press[platform.key()].contains(native)
    }
    pub fn is_text(&self, platform: Platform, native: &str) -> bool {
        self.text[platform.key()].contains(native)
    }
    #[cfg(test)]
    pub fn mac_table(&self) -> &HashMap<String, String> {
        &self.maps["mac"]
    }
}
