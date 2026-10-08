//! Date.parse acceptance used by the display validator, including the legacy
//! grammar. Adapted from V8's DateParser (Copyright 2011 V8 project authors).
//! See V8-LICENSE.txt. No JavaScript engine or subprocess is used at runtime.
//! Frozen algorithm reference: V8 tag 12.4.254, src/date/dateparser{,-inl}.h
//! and dateparser.cc: https://github.com/v8/v8/tree/12.4.254/src/date
use chrono::{Offset, TimeZone};
use tepora_core::json_codec;
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    End,
    Number,
    Symbol(u8),
    Space,
    Word(u8, i64),
    Other,
}
#[derive(Clone, Copy, Debug)]
struct Token {
    kind: Kind,
    n: i64,
    len: usize,
}
const END: Token = Token {
    kind: Kind::End,
    n: 0,
    len: 0,
};
fn whitespace(u: u16) -> bool {
    matches!(u,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn word_space(u: u16) -> bool {
    whitespace(u) && !matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}
fn keyword(word: &[u16]) -> Kind {
    let prefix: Vec<_> = word
        .iter()
        .take(3)
        .map(|u| if (65..=90).contains(u) { *u + 32 } else { *u })
        .collect();
    for (i, name) in [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .enumerate()
    {
        if prefix == name.encode_utf16().collect::<Vec<_>>() {
            return Kind::Word(1, i as i64 + 1);
        }
    }
    if word.len() > 3 {
        return Kind::Word(0, 0);
    }
    let text = String::from_utf16_lossy(&prefix);
    match text.as_str() {
        "am" => Kind::Word(4, 0),
        "pm" => Kind::Word(4, 12),
        "ut" | "utc" | "z" | "gmt" => Kind::Word(2, 0),
        "cdt" | "est" => Kind::Word(2, -5),
        "cst" | "mdt" => Kind::Word(2, -6),
        "edt" => Kind::Word(2, -4),
        "mst" | "pdt" => Kind::Word(2, -7),
        "pst" => Kind::Word(2, -8),
        "t" => Kind::Word(3, 0),
        _ => Kind::Word(0, 0),
    }
}
struct Scanner {
    units: Vec<u16>,
    pos: usize,
    ahead: Token,
}
impl Scanner {
    fn new(text: &str) -> Self {
        let mut scanner = Self {
            units: json_codec::utf16_units(text),
            pos: 0,
            ahead: END,
        };
        scanner.ahead = scanner.scan();
        scanner
    }
    fn scan(&mut self) -> Token {
        if self.pos >= self.units.len() || self.units[self.pos] == 0 {
            return END;
        }
        let unit = self.units[self.pos];
        let start = self.pos;
        let kind = if (48..=57).contains(&unit) {
            while self.pos < self.units.len() && (48..=57).contains(&self.units[self.pos]) {
                self.pos += 1;
            }
            let significant = self.units[start..self.pos]
                .iter()
                .copied()
                .skip_while(|u| *u == 48)
                .take(9);
            let n = significant.fold(0i64, |n, u| n * 10 + (u - 48) as i64);
            return Token {
                kind: Kind::Number,
                n,
                len: self.pos - start,
            };
        } else if matches!(unit, 58 | 45 | 43 | 46 | 41) {
            self.pos += 1;
            Kind::Symbol(unit as u8)
        } else if unit >= 65 && !word_space(unit) {
            while self.pos < self.units.len()
                && self.units[self.pos] >= 65
                && !word_space(self.units[self.pos])
            {
                self.pos += 1;
            }
            keyword(&self.units[start..self.pos])
        } else if whitespace(unit) {
            self.pos += 1;
            Kind::Space
        } else if unit == 40 {
            let mut balance = 0;
            while self.pos < self.units.len() && self.units[self.pos] != 0 {
                if self.units[self.pos] == 40 {
                    balance += 1;
                } else if self.units[self.pos] == 41 {
                    balance -= 1;
                }
                self.pos += 1;
                if balance == 0 {
                    break;
                }
            }
            Kind::Other
        } else {
            self.pos += 1;
            Kind::Other
        };
        Token {
            kind,
            n: 0,
            len: self.pos - start,
        }
    }
    fn peek(&self) -> Token {
        self.ahead
    }
    fn next(&mut self) -> Token {
        let token = self.ahead;
        if token.kind != Kind::End {
            self.ahead = self.scan();
        }
        token
    }
    fn skip(&mut self, c: u8) -> bool {
        if self.peek().kind == Kind::Symbol(c) {
            self.next();
            true
        } else {
            false
        }
    }
    fn fixed(&self, len: usize) -> bool {
        self.peek().kind == Kind::Number && self.peek().len == len
    }
}

#[derive(Default)]
struct Parsed {
    day: Vec<i64>,
    named: Option<i64>,
    iso: bool,
    time: Vec<i64>,
    half_day: Option<i64>,
    sign: Option<i64>,
    zone_hour: Option<i64>,
    zone_minute: Option<i64>,
}
impl Parsed {
    fn day(&mut self, n: i64) -> bool {
        if self.day.len() == 3 {
            false
        } else {
            self.day.push(n);
            true
        }
    }
    fn time(&mut self, n: i64) -> bool {
        if self.time.len() == 4 {
            false
        } else {
            self.time.push(n);
            true
        }
    }
    fn time_expects(&self, n: i64) -> bool {
        match self.time.len() {
            1 | 2 => (0..=59).contains(&n),
            3 => (0..=999).contains(&n),
            _ => false,
        }
    }
    fn final_time(&mut self, n: i64) {
        self.time(n);
        self.time.resize(4, 0);
    }
    fn zone(&mut self, h: i64) {
        self.sign = Some(if h < 0 { -1 } else { 1 });
        self.zone_hour = Some(h.abs());
        self.zone_minute = Some(0);
    }
    fn utc(&self) -> bool {
        self.zone_hour == Some(0) && self.zone_minute == Some(0)
    }
    fn zone_expects(&self, n: i64) -> bool {
        self.zone_hour.is_some() && self.zone_minute.is_none() && (0..=59).contains(&n)
    }
}
fn millisecond(token: Token) -> i64 {
    match token.len {
        0 => 0,
        1 => token.n * 100,
        2 => token.n * 10,
        3 => token.n,
        _ => token.n / 10i64.pow((token.len.min(9) - 3) as u32),
    }
}
fn sign(token: Token) -> Option<i64> {
    match token.kind {
        Kind::Symbol(b'+') => Some(1),
        Kind::Symbol(b'-') => Some(-1),
        _ => None,
    }
}
fn z(token: Token) -> bool {
    token.kind == Kind::Word(2, 0) && token.len == 1
}
fn iso(scan: &mut Scanner, p: &mut Parsed) -> Result<Token, ()> {
    if let Some(sign_value) = sign(scan.peek()) {
        let symbol = scan.next();
        if !scan.fixed(6) {
            return Ok(symbol);
        }
        let year = scan.next().n;
        if sign_value < 0 && year == 0 {
            return Ok(symbol);
        }
        p.day(sign_value * year);
    } else if scan.fixed(4) {
        p.day(scan.next().n);
    } else {
        return Ok(scan.next());
    }
    if scan.skip(b'-') {
        if !scan.fixed(2) || !(1..=12).contains(&scan.peek().n) {
            return Ok(scan.next());
        }
        p.day(scan.next().n);
        if scan.skip(b'-') {
            if !scan.fixed(2) || !(1..=31).contains(&scan.peek().n) {
                return Ok(scan.next());
            }
            p.day(scan.next().n);
        }
    }
    if scan.peek().kind != Kind::Word(3, 0) {
        if scan.peek().kind != Kind::End {
            return Ok(scan.next());
        }
    } else {
        scan.next();
        if !scan.fixed(2) || !(0..=24).contains(&scan.peek().n) {
            return Err(());
        }
        let last_hour = scan.peek().n == 24;
        p.time(scan.next().n);
        if !scan.skip(b':')
            || !scan.fixed(2)
            || !(0..=59).contains(&scan.peek().n)
            || last_hour && scan.peek().n > 0
        {
            return Err(());
        }
        p.time(scan.next().n);
        if scan.skip(b':') {
            if !scan.fixed(2)
                || !(0..=59).contains(&scan.peek().n)
                || last_hour && scan.peek().n > 0
            {
                return Err(());
            }
            p.time(scan.next().n);
            if scan.skip(b'.') {
                if scan.peek().kind != Kind::Number || last_hour && scan.peek().n > 0 {
                    return Err(());
                }
                p.time(millisecond(scan.next()));
            }
        }
        if z(scan.peek()) {
            scan.next();
            p.zone(0);
        } else if let Some(direction) = sign(scan.peek()) {
            scan.next();
            p.sign = Some(direction);
            if scan.fixed(4) {
                let n = scan.next().n;
                let (h, m) = (n / 100, n % 100);
                if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
                    return Err(());
                }
                p.zone_hour = Some(h);
                p.zone_minute = Some(m);
            } else {
                if !scan.fixed(2) || !(0..=23).contains(&scan.peek().n) {
                    return Err(());
                }
                p.zone_hour = Some(scan.next().n);
                if !scan.skip(b':') || !scan.fixed(2) || !(0..=59).contains(&scan.peek().n) {
                    return Err(());
                }
                p.zone_minute = Some(scan.next().n);
            }
        }
        if scan.peek().kind != Kind::End {
            return Err(());
        }
    }
    if p.zone_hour.is_none() && p.time.is_empty() {
        p.zone(0);
    }
    p.iso = true;
    Ok(END)
}
fn parse(text: &str) -> Option<Parsed> {
    let mut scan = Scanner::new(text);
    let mut p = Parsed::default();
    let mut token = iso(&mut scan, &mut p).ok()?;
    let mut number = !p.day.is_empty();
    while token.kind != Kind::End {
        match token.kind {
            Kind::Number => {
                number = true;
                let n = token.n;
                if scan.skip(b':') {
                    if scan.skip(b':') {
                        if !p.time.is_empty() {
                            return None;
                        }
                        p.time(n);
                        p.time(0);
                    } else {
                        if !p.time(n) {
                            return None;
                        }
                        scan.skip(b'.');
                    }
                } else if scan.skip(b'.') && p.time_expects(n) {
                    p.time(n);
                    if scan.peek().kind != Kind::Number {
                        return None;
                    }
                    let ms = millisecond(scan.next());
                    if ms < 0 {
                        return None;
                    }
                    p.final_time(ms);
                } else if p.zone_expects(n) {
                    p.zone_minute = Some(n);
                } else if p.time_expects(n) {
                    p.final_time(n);
                    let next = scan.peek();
                    if !matches!(next.kind, Kind::End | Kind::Space)
                        && !z(next)
                        && sign(next).is_none()
                    {
                        return None;
                    }
                } else {
                    if !p.day(n) {
                        return None;
                    }
                    scan.skip(b'-');
                }
            }
            Kind::Word(kind, n) => {
                if kind == 4 && !p.time.is_empty() {
                    p.half_day = Some(n);
                } else if kind == 1 {
                    p.named = Some(n);
                    scan.skip(b'-');
                } else if kind == 2 && number {
                    p.zone(n);
                } else if number || scan.peek().kind == Kind::Number {
                    return None;
                }
            }
            Kind::Symbol(b'+' | b'-') if p.utc() || !p.time.is_empty() => {
                p.sign = sign(token);
                let mut n = 0;
                let mut len = 0;
                if scan.peek().kind == Kind::Number {
                    let next = scan.next();
                    n = next.n;
                    len = next.len;
                }
                number = true;
                if scan.peek().kind == Kind::Symbol(b':') {
                    p.zone_hour = Some(n);
                    p.zone_minute = None;
                } else if len == 1 || len == 2 {
                    p.zone_hour = Some(n);
                    p.zone_minute = Some(0);
                } else if len == 3 || len == 4 {
                    p.zone_hour = Some(n / 100);
                    p.zone_minute = Some(n % 100);
                } else {
                    return None;
                }
            }
            Kind::Symbol(b'+' | b'-' | b')') if number => return None,
            _ => {}
        }
        token = scan.next();
    }
    Some(p)
}
fn leap(year: i64) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}
fn days(year: i64, month: i64, day: i64) -> i128 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yo = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yo * 365 + yo / 4 - yo / 100 + doy;
    (era * 146097 + doe - 719468) as i128
}
fn local_offset(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> Option<i32> {
    // Only TimeClip boundary dates reach this path. Chrono's supported year
    // interval is narrower than ECMAScript's: past boundary dates use the zone's
    // pre-transition offset, future dates use an equivalent Gregorian calendar.
    let mapped = if year < 1 {
        if leap(year) {
            1600
        } else {
            1601
        }
    } else if year > 2400 {
        let weekday = days(year, 1, 1).rem_euclid(7);
        (2400..2428).find(|y| leap(*y) == leap(year) && days(*y, 1, 1).rem_euclid(7) == weekday)?
    } else {
        year
    };
    let naive = chrono::NaiveDate::from_ymd_opt(mapped as i32, month, 1)?.and_hms_opt(0, 0, 0)?
        + chrono::Duration::days(day as i64 - 1)
        + chrono::Duration::hours(hour as i64)
        + chrono::Duration::minutes(minute as i64)
        + chrono::Duration::seconds(second as i64);
    let local = chrono::Local
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| {
            chrono::Local
                .from_local_datetime(&(naive - chrono::Duration::hours(3)))
                .earliest()
        })?;
    Some(local.offset().fix().local_minus_utc())
}
const LIMIT: i128 = 8640000000000000;
struct Calendar {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    wall_ms: i128,
    offset_seconds: Option<i128>,
}
fn calendar(text: &str) -> Option<Calendar> {
    let Some(mut p) = parse(text) else {
        return None;
    };
    if p.day.is_empty() {
        return None;
    }
    p.day.resize(3, 1);
    let (mut year, month, day) = if let Some(month) = p.named {
        if !(1..=31).contains(&p.day[0]) {
            (p.day[0], month, p.day[1])
        } else {
            (p.day[1], month, p.day[0])
        }
    } else if p.iso || !(1..=31).contains(&p.day[0]) {
        (p.day[0], p.day[1], p.day[2])
    } else {
        (p.day[2], p.day[0], p.day[1])
    };
    if !p.iso {
        if (0..=49).contains(&year) {
            year += 2000;
        } else if (50..=99).contains(&year) {
            year += 1900;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    p.time.resize(4, 0);
    let mut h = p.time[0];
    let (m, s, ms) = (p.time[1], p.time[2], p.time[3]);
    if let Some(half) = p.half_day {
        if !(0..=12).contains(&h) {
            return None;
        }
        h = h % 12 + half;
    }
    if !(0..=23).contains(&h)
        || !(0..=59).contains(&m)
        || !(0..=59).contains(&s)
        || !(0..=999).contains(&ms)
    {
        if h != 24 || m != 0 || s != 0 || ms != 0 {
            return None;
        }
    }
    let time = days(year, month, day) * 86400000
        + h as i128 * 3600000
        + m as i128 * 60000
        + s as i128 * 1000
        + ms as i128;
    let offset_seconds = if let Some(sign) = p.sign {
        let seconds = (p.zone_hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((p.zone_minute.unwrap_or(0) as u32).wrapping_mul(60));
        if seconds > i32::MAX as u32 {
            return None;
        }
        Some(seconds as i128 * sign as i128)
    } else {
        None
    };
    Some(Calendar {
        year,
        month: month as u32,
        day: day as u32,
        hour: h as u32,
        minute: m as u32,
        second: s as u32,
        wall_ms: time,
        offset_seconds,
    })
}

pub(crate) fn valid(text: &str) -> bool {
    valid_with_offset(text, None)
}
fn valid_with_offset(text: &str, forced_local_offset: Option<i32>) -> bool {
    let Some(c) = calendar(text) else {
        return false;
    };
    let offset = if let Some(offset) = c.offset_seconds {
        offset
    } else {
        // Keep the display validator's existing boundary-only zone lookup.
        if c.wall_ms.abs() < LIMIT - 3 * 86400000 {
            return true;
        }
        if c.wall_ms.abs() > LIMIT + 3 * 86400000 {
            return false;
        }
        let Some(offset) = forced_local_offset
            .or_else(|| local_offset(c.year, c.month, c.day, c.hour, c.minute, c.second))
        else {
            return false;
        };
        offset as i128
    };
    (c.wall_ms - offset * 1000).abs() <= LIMIT
}

/// Parse the same grammar for saved schedules. The caller owns timezone/DST
/// conversion of an unzoned wall-clock value, keeping tests deterministic.
pub(crate) fn timestamp(text: &str, local: impl FnOnce(i64) -> Option<i64>) -> Option<i64> {
    let c = calendar(text)?;
    let time = match c.offset_seconds {
        Some(offset) => c.wall_ms.checked_sub(offset.checked_mul(1000)?)?,
        None => i128::from(local(c.wall_ms.try_into().ok()?)?),
    };
    (time.abs() <= LIMIT).then_some(time.try_into().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_node_date_parse_acceptance_preserves_legacy_and_iso_forms() {
        let fixture = json_codec::parse(include_str!("fixtures/dates.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            assert_eq!(
                valid_with_offset(case["text"].as_str().unwrap(), Some(0)),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["text"]
            );
        }
    }
}
