//! Pure compatibility rules for core/network-policy.mjs. URL parsing is WHATWG.
use super::{NetworkError, NetworkProfile};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Domain {
    Device,
    Lan,
    Cloud,
    Reserved,
    Name,
}
impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Device => "device",
            Self::Lan => "lan",
            Self::Cloud => "cloud",
            Self::Reserved => "reserved",
            Self::Name => "name",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "device" => Some(Self::Device),
            "lan" => Some(Self::Lan),
            "cloud" => Some(Self::Cloud),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkMode {
    Online,
    TrustedLan,
    Offline,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Purpose {
    Model,
    Vision,
    Worker,
    Web,
    PublicWeb,
    WebTool,
    Feed,
    Download,
}
impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Vision => "vision",
            Self::Worker => "worker",
            Self::Web => "web",
            Self::PublicWeb => "public-web",
            Self::WebTool => "web-tool",
            Self::Feed => "feed",
            Self::Download => "download",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkPolicy {
    pub revision: u64,
    pub mode: NetworkMode,
    pub internet_tools: bool,
}
impl Default for NetworkPolicy {
    fn default() -> Self {
        Self {
            revision: 0,
            mode: NetworkMode::Online,
            internet_tools: true,
        }
    }
}
impl NetworkPolicy {
    pub fn from_value(v: &Value) -> Result<Self, NetworkError> {
        if v.is_null() {
            return Ok(Self::default());
        }
        let mode = match v["mode"].as_str() {
            Some("online") => NetworkMode::Online,
            Some("trusted-lan") => NetworkMode::TrustedLan,
            Some("offline") => NetworkMode::Offline,
            _ => return Err(NetworkError::invalid("Invalid network policy")),
        };
        Ok(Self {
            revision: v["revision"]
                .as_u64()
                .filter(|n| *n <= crate::MAX_SAFE_INTEGER)
                .ok_or_else(|| NetworkError::invalid("Invalid network revision"))?,
            mode,
            internet_tools: v["internetTools"]
                .as_bool()
                .ok_or_else(|| NetworkError::invalid("Invalid network policy"))?,
        })
    }
    pub fn value(&self) -> Value {
        json!({"schema":1,"revision":self.revision,"mode":match self.mode {NetworkMode::Online=>"online",NetworkMode::TrustedLan=>"trusted-lan",NetworkMode::Offline=>"offline"},"internetTools":self.internet_tools})
    }
    pub fn permitted(&self, domain: Domain, purpose: Purpose) -> bool {
        use Domain::*;
        use Purpose::*;
        // Invalid domains must never become an implicit cloud permission.
        if matches!(domain, Reserved | Name) {
            return false;
        }
        if purpose == PublicWeb {
            return domain == Cloud && self.mode == NetworkMode::Online && self.internet_tools;
        }
        if purpose == WebTool {
            return self.internet_tools
                && (domain == Device
                    || domain == Lan && self.mode != NetworkMode::Offline
                    || domain == Cloud && self.mode == NetworkMode::Online);
        }
        if domain == Device {
            return purpose != Download || self.mode == NetworkMode::Online;
        }
        if self.mode == NetworkMode::Offline {
            return false;
        }
        if domain == Lan {
            return matches!(purpose, Model | Vision | Worker);
        }
        self.mode == NetworkMode::Online
            && (matches!(purpose, Model | Vision) || self.internet_tools)
    }
    pub(crate) fn narrows(&self, old: &Self) -> bool {
        [Domain::Device, Domain::Lan, Domain::Cloud]
            .into_iter()
            .any(|d| {
                [
                    Purpose::Model,
                    Purpose::Vision,
                    Purpose::Worker,
                    Purpose::Web,
                    Purpose::PublicWeb,
                    Purpose::WebTool,
                    Purpose::Feed,
                    Purpose::Download,
                ]
                .into_iter()
                .any(|p| old.permitted(d, p) && !self.permitted(d, p))
            })
    }
}
/// Keep lexical prefix rules identical to the JavaScript source, including its
/// intentionally conservative transitional/documentation address exclusions.
pub fn ip_domain(address: &str) -> Domain {
    let ip = address.to_ascii_lowercase();
    if ip.contains('%')
        || ip.starts_with("::ffff:")
        || ip.starts_with("2002:")
        || ip.starts_with("64:ff9b:")
    {
        return Domain::Reserved;
    }
    if ip == "::1" {
        return Domain::Device;
    }
    if let Ok(v) = ip.parse::<Ipv4Addr>() {
        let [a, b, c, _] = v.octets();
        if a == 127 {
            return Domain::Device;
        }
        if a == 10 || a == 172 && (16..=31).contains(&b) || a == 192 && b == 168 {
            return Domain::Lan;
        }
        if a == 0
            || a >= 224
            || a == 169 && b == 254
            || a == 100 && (64..=127).contains(&b)
            || a == 192 && (b == 0 || b == 2)
            || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
            || a == 203 && b == 0 && c == 113
        {
            return Domain::Reserved;
        }
        return Domain::Cloud;
    }
    if ip.parse::<Ipv6Addr>().is_ok() {
        if ip.starts_with("fc") || ip.starts_with("fd") {
            return Domain::Lan;
        }
        if ip.starts_with("fe")
            || ip.starts_with("ff")
            || ip.starts_with("::")
            || ip.starts_with("2001:db8")
            || ip.starts_with("2001:0:")
            || ip.starts_with("2001:20")
        {
            return Domain::Reserved;
        }
        return if ip.starts_with('2') || ip.starts_with('3') {
            Domain::Cloud
        } else {
            Domain::Reserved
        };
    }
    Domain::Name
}
pub fn normal_url(value: &str, query: bool) -> Result<Url, NetworkError> {
    let u = Url::parse(value).map_err(|_| NetworkError::invalid("接続先URLが不正です。"))?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some_and(|p| !p.is_empty())
        || u.fragment().is_some_and(|f| !f.is_empty())
        || !query && u.query().is_some_and(|q| !q.is_empty())
    {
        return Err(NetworkError::invalid(
            "資格情報・フラグメントを含まないHTTP(S) URLを指定してください。",
        ));
    }
    if u.host_str()
        .is_none_or(|s| s.contains('%') || s.contains('\\'))
    {
        return Err(NetworkError::invalid("Invalid hostname"));
    }
    Ok(u)
}
pub(crate) fn hostname(u: &Url) -> String {
    u.host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}
fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
fn has_escape(s: &str) -> bool {
    s.as_bytes()
        .windows(3)
        .any(|x| x[0] == b'%' && hex(x[1]).is_some() && hex(x[2]).is_some())
}
fn decode_component(s: &str) -> Option<String> {
    let input = s.as_bytes();
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            out.push(hex(*input.get(i + 1)?)? * 16 + hex(*input.get(i + 2)?)?);
            i += 3;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn canonical_path(p: &str) -> Option<String> {
    let mut p = p.to_owned();
    for _ in 0..4 {
        if !has_escape(&p) {
            break;
        }
        p = decode_component(&p)?;
    }
    let lower = p.to_ascii_lowercase();
    if p.contains('\\')
        || p.contains('\0')
        || ["%2e", "%2f", "%5c", "%25"]
            .into_iter()
            .any(|s| lower.contains(s))
    {
        return None;
    }
    let mut segments = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(part),
        }
    }
    if segments.is_empty() {
        Some(String::new())
    } else {
        Some(format!("/{}", segments.join("/")))
    }
}
pub fn inside_endpoint(value: &str, base: &str) -> bool {
    let (Ok(u), Ok(b)) = (Url::parse(value), Url::parse(base)) else {
        return false;
    };
    if u.origin() != b.origin() {
        return false;
    }
    let (Some(target), Some(prefix)) = (canonical_path(u.path()), canonical_path(b.path())) else {
        return false;
    };
    target == prefix || target.starts_with(&(prefix + "/"))
}
impl NetworkProfile {
    /// Only call with a trusted registry entry, never a model-supplied scope.
    pub fn from_value(v: &Value) -> Result<Self, NetworkError> {
        let base_url = v["baseUrl"]
            .as_str()
            .ok_or_else(|| NetworkError::invalid("Missing baseUrl"))?
            .to_owned();
        normal_url(&base_url, false)?;
        Ok(Self {
            id: v["id"].as_str().unwrap_or_default().to_owned(),
            base_url,
            domain: Domain::parse(v["domain"].as_str().unwrap_or(""))
                .ok_or_else(|| NetworkError::invalid("Invalid profile domain"))?,
            enabled: v["enabled"].as_bool().unwrap_or(false),
            pinned_address: v["pinnedAddress"].as_str().map(str::to_owned),
            allow_plain_http: v["allowPlainHttp"].as_bool().unwrap_or(false),
        })
    }
}
pub(crate) fn checked_ip(s: &str) -> Result<IpAddr, NetworkError> {
    s.parse()
        .map_err(|_| NetworkError::blocked("DNS returned an invalid address"))
}
