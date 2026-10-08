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
        if let Some(local) = Utc.timestamp_millis_opt(wall).single() {
            return clock.instant(local.naive_utc());
        }
        // ECMAScript's TimeClip range is wider than Chrono's calendar. Query
        // the zone with an equivalent calendar and retain the original epoch.
        let mapped = equivalent_wall(parts(wall))?;
        wall.checked_add(
            clock
                .instant(mapped)?
                .checked_sub(mapped.and_utc().timestamp_millis())?,
        )
    })
}

pub(super) struct Parts {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
}
/// Inverse proleptic Gregorian day arithmetic; valid over the full Date range.
pub(super) fn parts(ms: i64) -> Parts {
    let z = ms.div_euclid(86_400_000) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let time = ms.rem_euclid(86_400_000);
    Parts {
        year,
        month: month as u32,
        day: day as u32,
        hour: (time / 3_600_000) as u32,
        minute: (time / 60_000 % 60) as u32,
        second: (time / 1_000 % 60) as u32,
        millis: (time % 1_000) as u32,
    }
}
fn equivalent_wall(p: Parts) -> Option<NaiveDateTime> {
    let year = if p.year < 1 {
        if p.year.rem_euclid(4) == 0 && (p.year.rem_euclid(100) != 0 || p.year.rem_euclid(400) == 0)
        {
            1600
        } else {
            1601
        }
    } else {
        2000 + (p.year - 2000).rem_euclid(400)
    };
    chrono::NaiveDate::from_ymd_opt(year as i32, p.month, p.day)?
        .and_hms_milli_opt(p.hour, p.minute, p.second, p.millis)
}
pub(super) fn local_parts(ms: i64, clock: &dyn Clock) -> Option<Parts> {
    if let Some(local) = clock.local(ms) {
        return Some(parts(local.and_utc().timestamp_millis()));
    }
    let mapped = equivalent_wall(parts(ms))?.and_utc().timestamp_millis();
    let offset = clock
        .local(mapped)?
        .and_utc()
        .timestamp_millis()
        .checked_sub(mapped)?;
    Some(parts(ms.checked_add(offset)?))
}
