use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use serde_json::Value;

use crate::core::errors::ApiError;

pub async fn validate_fetch_target(
    config: &Value,
    parsed: &reqwest::Url,
) -> Result<FetchResolution, ApiError> {
    let host = parsed
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("URL host is missing".to_string()))?;
    let normalized_host = normalize_host_for_match(host);
    if normalized_host.is_empty() {
        return Err(ApiError::BadRequest("URL host is invalid".to_string()));
    }

    let denylist = url_denylist(config);
    if denylist
        .iter()
        .any(|pattern| host_matches_pattern(&normalized_host, pattern))
    {
        return Err(ApiError::Forbidden);
    }

    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        ensure_public_ip(ip)?;
        return Ok(FetchResolution::ip_literal());
    }

    let port = parsed.port_or_known_default().unwrap_or(80);
    let mut resolved = BTreeSet::new();
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(ApiError::internal)?;
    for address in addresses {
        ensure_public_ip(address.ip())?;
        resolved.insert(address);
    }
    if resolved.is_empty() {
        return Err(ApiError::BadRequest(
            "URL host could not be resolved".to_string(),
        ));
    }

    Ok(FetchResolution::from_dns(
        host.to_string(),
        resolved.into_iter().collect(),
    ))
}

#[derive(Debug, Clone)]
pub struct FetchResolution {
    host: Option<String>,
    addrs: Vec<SocketAddr>,
}

impl FetchResolution {
    fn ip_literal() -> Self {
        Self {
            host: None,
            addrs: Vec::new(),
        }
    }

    fn from_dns(host: String, addrs: Vec<SocketAddr>) -> Self {
        Self {
            host: Some(host),
            addrs,
        }
    }

    pub fn pinned_dns(&self) -> Option<(&str, &[SocketAddr])> {
        self.host
            .as_deref()
            .map(|host| (host, self.addrs.as_slice()))
    }
}

pub fn allow_web_search(config: &Value) -> bool {
    if is_isolation_mode(config) {
        return false;
    }
    config
        .get("privacy")
        .and_then(|v| v.get("allow_web_search"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn is_isolation_mode(config: &Value) -> bool {
    config
        .get("privacy")
        .and_then(|v| v.get("isolation_mode"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn web_fetch_max_chars(config: &Value) -> usize {
    config
        .get("app")
        .and_then(|v| v.get("web_fetch_max_chars"))
        .and_then(|v| v.as_u64())
        .unwrap_or(6000)
        .clamp(256, 200_000) as usize
}

pub fn web_fetch_max_bytes(config: &Value) -> usize {
    config
        .get("app")
        .and_then(|v| v.get("web_fetch_max_bytes"))
        .and_then(|v| v.as_u64())
        .unwrap_or(1_000_000)
        .clamp(1024, 10_000_000) as usize
}

pub fn web_fetch_timeout_secs(config: &Value) -> u64 {
    config
        .get("app")
        .and_then(|v| v.get("web_fetch_timeout_secs"))
        .and_then(|v| v.as_u64())
        .unwrap_or(10)
        .clamp(1, 120)
}

fn ensure_public_ip(ip: IpAddr) -> Result<(), ApiError> {
    if is_blocked_ip(ip) {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || is_ipv4_cgnat(ip)
        || is_ipv4_benchmark(ip)
        || is_ipv4_documentation(ip)
        || octets[0] == 0
        || (octets[0] & 0b1111_0000) == 0b1111_0000
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4() {
        return is_blocked_ipv4(mapped);
    }

    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || is_ipv6_documentation(ip)
}

fn is_ipv4_cgnat(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_ipv4_benchmark(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
}

fn is_ipv4_documentation(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
}

fn is_ipv6_documentation(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0x2001 && segments[1] == 0x0db8
}

fn url_denylist(config: &Value) -> Vec<String> {
    let mut out = default_url_denylist();
    if let Some(list) = config
        .get("privacy")
        .and_then(|v| v.get("url_denylist"))
        .and_then(|v| v.as_array())
    {
        for entry in list {
            if let Some(item) = entry.as_str() {
                let candidate = item.trim();
                if !candidate.is_empty() {
                    out.push(candidate.to_string());
                }
            }
        }
    }
    out
}

fn default_url_denylist() -> Vec<String> {
    vec![
        "localhost".to_string(),
        "*.localhost".to_string(),
        "*.local".to_string(),
        "*.internal".to_string(),
        "*.home.arpa".to_string(),
        "metadata.google.internal".to_string(),
        "127.0.0.1".to_string(),
        "0.0.0.0".to_string(),
        "192.168.*".to_string(),
        "10.*".to_string(),
        "172.16.*".to_string(),
        "172.17.*".to_string(),
        "172.18.*".to_string(),
        "172.19.*".to_string(),
        "172.20.*".to_string(),
        "172.21.*".to_string(),
        "172.22.*".to_string(),
        "172.23.*".to_string(),
        "172.24.*".to_string(),
        "172.25.*".to_string(),
        "172.26.*".to_string(),
        "172.27.*".to_string(),
        "172.28.*".to_string(),
        "172.29.*".to_string(),
        "172.30.*".to_string(),
        "172.31.*".to_string(),
        "169.254.*".to_string(),
        "::1".to_string(),
        "fd*".to_string(),
        "fe80:*".to_string(),
    ]
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    let host = normalize_host_for_match(host);
    let pattern = pattern.to_ascii_lowercase();

    if pattern.contains('*') {
        let prefix = pattern.trim_end_matches('*');
        if pattern.starts_with('*') {
            let suffix = pattern.trim_start_matches('*');
            return host.ends_with(suffix);
        }
        return host.starts_with(prefix);
    }
    host == pattern
}

fn normalize_host_for_match(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_web_search_defaults_to_false_and_reads_true_flag() {
        assert!(!allow_web_search(&serde_json::json!({})));
        assert!(allow_web_search(&serde_json::json!({
            "privacy": {
                "allow_web_search": true
            }
        })));
    }

    #[test]
    fn web_fetch_limits_default_when_missing() {
        let config = serde_json::json!({});
        assert_eq!(web_fetch_max_chars(&config), 6000);
        assert_eq!(web_fetch_max_bytes(&config), 1_000_000);
        assert_eq!(web_fetch_timeout_secs(&config), 10);
    }

    #[test]
    fn web_fetch_limits_are_clamped() {
        let lower = serde_json::json!({
            "app": {
                "web_fetch_max_chars": 1,
                "web_fetch_max_bytes": 512,
                "web_fetch_timeout_secs": 0
            }
        });
        assert_eq!(web_fetch_max_chars(&lower), 256);
        assert_eq!(web_fetch_max_bytes(&lower), 1024);
        assert_eq!(web_fetch_timeout_secs(&lower), 1);

        let upper = serde_json::json!({
            "app": {
                "web_fetch_max_chars": 300000,
                "web_fetch_max_bytes": 99999999,
                "web_fetch_timeout_secs": 999
            }
        });
        assert_eq!(web_fetch_max_chars(&upper), 200_000);
        assert_eq!(web_fetch_max_bytes(&upper), 10_000_000);
        assert_eq!(web_fetch_timeout_secs(&upper), 120);
    }

    #[test]
    fn blocks_private_and_loopback_ipv4() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
    }

    #[test]
    fn allows_public_ipv4() {
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn blocks_non_public_special_ipv4_ranges() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 2))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))));
    }

    #[test]
    fn blocks_private_ipv6_ranges() {
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_blocked_ip(IpAddr::V6(
            "fc00::1".parse().expect("valid IPv6")
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "fe80::1".parse().expect("valid IPv6")
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "2001:db8::1".parse().expect("valid IPv6")
        )));
    }

    #[test]
    fn host_pattern_matching_handles_wildcards() {
        assert!(host_matches_pattern("api.localhost", "*.localhost"));
        assert!(host_matches_pattern("192.168.1.10", "192.168.*"));
        assert!(!host_matches_pattern("example.com", "*.localhost"));
    }

    #[test]
    fn host_matching_normalizes_trailing_dot() {
        assert!(host_matches_pattern("LOCALHOST.", "localhost"));
        assert!(host_matches_pattern("api.localhost.", "*.localhost"));
    }

    #[test]
    fn host_matching_is_case_insensitive_for_prefix_patterns() {
        assert!(host_matches_pattern("FD00::1", "fd*"));
        assert!(host_matches_pattern("FE80::abcd", "fe80:*"));
    }

    #[test]
    fn default_denylist_blocks_internal_suffixes() {
        let defaults = default_url_denylist();
        assert!(defaults.contains(&"*.local".to_string()));
        assert!(defaults.contains(&"*.internal".to_string()));
        assert!(defaults.contains(&"metadata.google.internal".to_string()));
    }

    #[test]
    fn url_denylist_includes_defaults_and_custom_values() {
        let config = serde_json::json!({
            "privacy": {
                "url_denylist": ["example.internal", "  "]
            }
        });
        let list = url_denylist(&config);
        assert!(list.contains(&"localhost".to_string()));
        assert!(list.contains(&"example.internal".to_string()));
    }

    #[test]
    fn isolation_mode_defaults_to_false() {
        assert!(!is_isolation_mode(&serde_json::json!({})));
        assert!(!is_isolation_mode(&serde_json::json!({
            "privacy": {}
        })));
    }

    #[test]
    fn isolation_mode_reads_config_flag() {
        assert!(is_isolation_mode(&serde_json::json!({
            "privacy": {
                "isolation_mode": true
            }
        })));
        assert!(!is_isolation_mode(&serde_json::json!({
            "privacy": {
                "isolation_mode": false
            }
        })));
    }

    #[test]
    fn isolation_mode_overrides_allow_web_search() {
        let config = serde_json::json!({
            "privacy": {
                "allow_web_search": true,
                "isolation_mode": true
            }
        });
        assert!(!allow_web_search(&config));

        let config = serde_json::json!({
            "privacy": {
                "allow_web_search": true,
                "isolation_mode": false
            }
        });
        assert!(allow_web_search(&config));
    }
}
