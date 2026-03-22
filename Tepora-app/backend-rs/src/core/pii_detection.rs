use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiiFinding {
    pub category: String,
    pub preview: String,
}

pub fn detect_pii(text: &str) -> Vec<PiiFinding> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut findings = Vec::new();
    collect_regex_findings(email_regex(), text, "email", &mut findings);
    collect_phone_findings(text, &mut findings);
    collect_regex_findings(api_key_regex(), text, "api_key", &mut findings);
    collect_regex_findings(token_regex(), text, "token", &mut findings);
    collect_card_findings(text, &mut findings);
    dedupe_findings(findings)
}

pub fn detect_pii_in_attachments(attachments: &[Value]) -> Vec<PiiFinding> {
    let mut findings = Vec::new();
    for attachment in attachments {
        let Some(object) = attachment.as_object() else {
            continue;
        };
        if object
            .get("piiConfirmed")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(url) = object.get("url").and_then(|value| value.as_str()) {
            findings.extend(detect_pii(url));
        }
        let attachment_type = object
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let is_text = attachment_type.eq_ignore_ascii_case("text")
            || attachment_type.starts_with("text/")
            || attachment_type == "application/json"
            || attachment_type == "application/xml"
            || attachment_type == "application/yaml"
            || attachment_type == "application/toml";
        if !is_text {
            continue;
        }
        if let Some(content) = object.get("content").and_then(|value| value.as_str()) {
            if !content.starts_with("data:") {
                findings.extend(detect_pii(content));
            }
        }
    }
    dedupe_findings(findings)
}

fn collect_regex_findings(
    regex: &Regex,
    text: &str,
    category: &str,
    findings: &mut Vec<PiiFinding>,
) {
    for found in regex.find_iter(text) {
        findings.push(PiiFinding {
            category: category.to_string(),
            preview: preview(found.as_str()),
        });
    }
}

fn collect_phone_findings(text: &str, findings: &mut Vec<PiiFinding>) {
    for found in phone_regex().find_iter(text) {
        let digits = found
            .as_str()
            .chars()
            .filter(|value| value.is_ascii_digit())
            .count();
        if digits >= 10 {
            findings.push(PiiFinding {
                category: "phone".to_string(),
                preview: preview(found.as_str()),
            });
        }
    }
}

fn collect_card_findings(text: &str, findings: &mut Vec<PiiFinding>) {
    for found in card_regex().find_iter(text) {
        let digits = found
            .as_str()
            .chars()
            .filter(|value| value.is_ascii_digit())
            .collect::<String>();
        if (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
            findings.push(PiiFinding {
                category: "card".to_string(),
                preview: preview(found.as_str()),
            });
        }
    }
}

fn dedupe_findings(findings: Vec<PiiFinding>) -> Vec<PiiFinding> {
    let mut seen = HashSet::new();
    findings
        .into_iter()
        .filter(|finding| seen.insert((finding.category.clone(), finding.preview.clone())))
        .collect()
}

fn preview(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= 12 {
        return trimmed.to_string();
    }
    let prefix: String = trimmed.chars().take(4).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}...{suffix}")
}

fn email_regex() -> &'static Regex {
    static EMAIL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    EMAIL.get_or_init(|| {
        Regex::new(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b").expect("valid email regex")
    })
}

fn phone_regex() -> &'static Regex {
    static PHONE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PHONE.get_or_init(|| Regex::new(r"(?x)(?:\+?\d[\d\-\s().]{7,}\d)").expect("valid phone regex"))
}

fn api_key_regex() -> &'static Regex {
    static API_KEY: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    API_KEY.get_or_init(|| {
        Regex::new(r"(?i)\b(?:sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|AIza[0-9A-Za-z\-_]{20,}|AKIA[0-9A-Z]{16})\b")
            .expect("valid api key regex")
    })
}

fn token_regex() -> &'static Regex {
    static TOKEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:token|bearer|jwt)[=: ]+[a-z0-9._\-]{16,}\b")
            .expect("valid token regex")
    })
}

fn card_regex() -> &'static Regex {
    static CARD: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    CARD.get_or_init(|| Regex::new(r"\b(?:\d[ -]*?){13,19}\b").expect("valid card regex"))
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0;
    let mut alternate = false;
    for ch in digits.chars().rev() {
        let Some(mut value) = ch.to_digit(10) else {
            return false;
        };
        if alternate {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
        alternate = !alternate;
    }
    sum % 10 == 0
}
