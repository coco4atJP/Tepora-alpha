//! A minimal AT-SPI2 client over D-Bus (zbus, blocking): the accessibility tree of X11 apps.
use crate::protocol::{HelperError, Rect, Result};
use std::time::Duration;
use zbus::blocking::{connection, Connection};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

pub const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const ACTION: &str = "org.a11y.atspi.Action";
const TEXT: &str = "org.a11y.atspi.Text";
const EDITABLE: &str = "org.a11y.atspi.EditableText";
const VALUE: &str = "org.a11y.atspi.Value";
const PROPS: &str = "org.freedesktop.DBus.Properties";
const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT: &str = "/org/a11y/atspi/accessible/root";

/// AT-SPI state bits (atspi-constants.h).
pub mod state {
    pub const ACTIVE: u32 = 1;
    pub const CHECKED: u32 = 4;
    pub const ENABLED: u32 = 8;
    pub const EXPANDABLE: u32 = 9;
    pub const EXPANDED: u32 = 10;
    pub const FOCUSED: u32 = 12;
    pub const PRESSED: u32 = 20;
    pub const SELECTED: u32 = 23;
    pub const SENSITIVE: u32 = 24;
    pub const SHOWING: u32 = 25;
}

/// The state set as AT-SPI sends it: two 32-bit words.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct States(pub u64);
impl States {
    pub fn from_words(words: &[u32]) -> States {
        let lo = *words.first().unwrap_or(&0) as u64;
        let hi = *words.get(1).unwrap_or(&0) as u64;
        States(lo | (hi << 32))
    }
    pub fn has(&self, bit: u32) -> bool {
        bit < 64 && self.0 & (1u64 << bit) != 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Obj {
    pub bus: String,
    pub path: String,
}

pub struct Atspi {
    conn: Connection,
}

impl Atspi {
    pub fn connect() -> Result<Atspi> {
        let address = match std::env::var("AT_SPI_BUS_ADDRESS") {
            Ok(a) if !a.is_empty() => a,
            _ => {
                let session = Connection::session().map_err(|e| HelperError::new(format!("No D-Bus session bus for accessibility ({e}).")))?;
                let reply = session
                    .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
                    .map_err(|e| HelperError::new(format!("The accessibility bus (at-spi2) is not running ({e}).")))?;
                reply.body().deserialize::<String>()?
            }
        };
        let conn = connection::Builder::address(address.as_str())?.method_timeout(Duration::from_secs(3)).build()?;
        Ok(Atspi { conn })
    }

    fn call<B, R>(&self, obj: &Obj, iface: &str, method: &str, body: &B) -> Result<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'a> serde::Deserialize<'a> + zbus::zvariant::Type,
    {
        let msg = self.conn.call_method(Some(obj.bus.as_str()), obj.path.as_str(), Some(iface), method, body)?;
        Ok(msg.body().deserialize::<R>()?)
    }
    fn prop(&self, obj: &Obj, iface: &str, name: &str) -> Result<OwnedValue> {
        self.call(obj, PROPS, "Get", &(iface, name))
    }

    pub fn root() -> Obj {
        Obj { bus: REGISTRY.into(), path: ROOT.into() }
    }
    pub fn children(&self, obj: &Obj) -> Vec<Obj> {
        self.call::<_, Vec<(String, OwnedObjectPath)>>(obj, ACCESSIBLE, "GetChildren", &())
            .map(|v| v.into_iter().map(|(bus, path)| Obj { bus, path: path.as_str().to_owned() }).filter(|o| o.path != "/org/a11y/atspi/null").collect())
            .unwrap_or_default()
    }
    pub fn pid_of(&self, bus: &str) -> Option<u32> {
        let msg = self
            .conn
            .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetConnectionUnixProcessID", &(bus,))
            .ok()?;
        msg.body().deserialize::<u32>().ok()
    }
    /// The application object of a process, if it exposes accessibility.
    pub fn app(&self, pid: u32) -> Option<Obj> {
        self.children(&Self::root()).into_iter().find(|a| self.pid_of(&a.bus) == Some(pid))
    }
    pub fn role(&self, obj: &Obj) -> String {
        self.call::<_, String>(obj, ACCESSIBLE, "GetRoleName", &()).unwrap_or_default()
    }
    pub fn name(&self, obj: &Obj) -> String {
        self.prop(obj, ACCESSIBLE, "Name").ok().and_then(|v| String::try_from(v).ok()).unwrap_or_default()
    }
    pub fn description(&self, obj: &Obj) -> String {
        self.prop(obj, ACCESSIBLE, "Description").ok().and_then(|v| String::try_from(v).ok()).unwrap_or_default()
    }
    pub fn states(&self, obj: &Obj) -> States {
        self.call::<_, Vec<u32>>(obj, ACCESSIBLE, "GetState", &()).map(|w| States::from_words(&w)).unwrap_or_default()
    }
    /// The first label that labels this object (relation LABELLED_BY = 2).
    pub fn labelled_by(&self, obj: &Obj) -> Option<String> {
        let rels = self.call::<_, Vec<(u32, Vec<(String, OwnedObjectPath)>)>>(obj, ACCESSIBLE, "GetRelationSet", &()).ok()?;
        let (_, targets) = rels.into_iter().find(|(kind, t)| *kind == 2 && !t.is_empty())?;
        let (bus, path) = targets.into_iter().next()?;
        Some(self.name(&Obj { bus, path: path.as_str().to_owned() })).filter(|s| !s.trim().is_empty())
    }
    /// Screen-coordinate extents (coord type 0 = screen).
    pub fn extents(&self, obj: &Obj) -> Option<Rect> {
        let (x, y, w, h) = self.call::<_, (i32, i32, i32, i32)>(obj, COMPONENT, "GetExtents", &(0u32,)).ok()?;
        Some(Rect { x: x as f64, y: y as f64, w: w as f64, h: h as f64 })
    }
    pub fn grab_focus(&self, obj: &Obj) -> bool {
        self.call::<_, bool>(obj, COMPONENT, "GrabFocus", &()).unwrap_or(false)
    }
    pub fn actions(&self, obj: &Obj) -> Vec<String> {
        self.call::<_, Vec<(String, String, String)>>(obj, ACTION, "GetActions", &())
            .map(|v| v.into_iter().map(|(n, _, _)| n).collect())
            .unwrap_or_default()
    }
    pub fn do_action(&self, obj: &Obj, index: usize) -> bool {
        self.call::<_, bool>(obj, ACTION, "DoAction", &(index as i32,)).unwrap_or(false)
    }
    pub fn char_count(&self, obj: &Obj) -> Option<i32> {
        self.prop(obj, TEXT, "CharacterCount").ok().and_then(|v| i32::try_from(v).ok())
    }
    /// Whether the object implements an interface (asking a toolkit for one it lacks logs criticals in the app).
    pub fn implements(&self, obj: &Obj, interface: &str) -> bool {
        self.call::<_, Vec<String>>(obj, ACCESSIBLE, "GetInterfaces", &()).map(|l| l.iter().any(|i| i == interface)).unwrap_or(false)
    }
    pub fn text(&self, obj: &Obj) -> Option<String> {
        if !self.implements(obj, TEXT) {
            return None;
        }
        self.call::<_, String>(obj, TEXT, "GetText", &(0i32, -1i32)).ok()
    }
    pub fn set_text(&self, obj: &Obj, text: &str) -> bool {
        self.call::<_, bool>(obj, EDITABLE, "SetTextContents", &(text,)).unwrap_or(false)
    }
    pub fn current_value(&self, obj: &Obj) -> Option<f64> {
        self.prop(obj, VALUE, "CurrentValue").ok().and_then(|v| f64::try_from(v).ok())
    }
}

/// The action that presses a control, by the names toolkits use (GTK "click"/"activate", Qt "Press").
pub fn press_action(names: &[String]) -> Option<usize> {
    for wanted in ["click", "press", "activate", "toggle", "jump", "open"] {
        if let Some(i) = names.iter().position(|n| n.eq_ignore_ascii_case(wanted)) {
            return Some(i);
        }
    }
    if names.is_empty() {
        None
    } else {
        Some(0)
    }
}
