use super::*;
use regex::Regex;
use std::sync::OnceLock;

/// Source's local HH:mm roll-forward and date-only 09:00 shorthand. Other
/// supported JavaScript date spellings pass through the native parser below.
pub fn parse_when(at: &str, now: i64, clock: &dyn Clock) -> Option<i64> {
    let value = trim(at);
    static HM: OnceLock<Regex> = OnceLock::new();
    if let Some(c) = HM
        .get_or_init(|| Regex::new(r"^(\d{1,2}):(\d{2})$").unwrap())
        .captures(value)
    {
        let local = clock.local(now)?;
        let midnight = local.date().and_hms_opt(0, 0, 0)?;
        let desired = midnight.checked_add_signed(chrono::Duration::minutes(
            c[1].parse::<i64>().ok()? * 60 + c[2].parse::<i64>().ok()?,
        ))?;
        let when = clock.instant(desired)?;
        return if when <= now {
            clock.instant(
                clock
                    .local(when)?
                    .checked_add_signed(chrono::Duration::days(1))?,
            )
        } else {
            Some(when)
        };
    }
    let bare = value.len() == 10
        && value.as_bytes().iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if bare {
        return parse_instant(&format!("{value}T09:00"), clock);
    }
    parse_instant(value, clock)
}
pub(super) fn parse_instant(raw: &str, clock: &dyn Clock) -> Option<i64> {
    crate::js_date::timestamp(raw, |wall| {
        let local = Utc.timestamp_millis_opt(wall).single()?.naive_utc();
        clock.instant(local)
    })
}
