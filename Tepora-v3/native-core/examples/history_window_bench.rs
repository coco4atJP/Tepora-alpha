//! Synthetic, local-only history read benchmark. Prepare once, then run each
//! mode in a fresh process against the same unchanged fixture:
//! history_window_bench DB prepare N
//! history_window_bench DB page-before|page-after|context-before|context-after
use serde_json::{json, Value};
use std::time::Instant;
use tepora_core::{compute_json, NativeState};
fn view(entries: &Value) -> Value {
    let entries = entries.as_array().unwrap();
    let cp = entries.iter().rev().find(|e| e["type"] == "checkpoint").cloned().unwrap_or(Value::Null);
    let from = cp["upTo"].as_u64().unwrap_or(0).saturating_add(1);
    let entries: Vec<_> = entries.iter().filter(|e|e["seq"].as_u64().is_some_and(|n|n>=from)).collect();
    serde_json::from_str(&compute_json("context.view", &json!({"checkpoint":cp,"entries":entries}).to_string()).unwrap()).unwrap()
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args[2] == "prepare" || args[2].starts_with("append-") {
        assert!(!std::path::Path::new(&args[1]).exists(), "Synthetic fixture destination must not exist");
    }
    let opening = Instant::now();
    let mut state = NativeState::open(&args[1]).unwrap();
    if args[2] == "open" {
        println!("{}",json!({"mode":"open","elapsedMs":opening.elapsed().as_secs_f64()*1000.0}));
        return;
    }
    if args[2] == "prepare" {
        let n: usize = args[3].parse().unwrap();
        let mut db = rusqlite::Connection::open(&args[1]).unwrap();
        let tx = db.transaction().unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO session_log(session_id,seq,type,body,at) VALUES('bench',?,?,?,'2026-10-08')").unwrap();
            for seq in 1..=n {
                let (kind, body) = if seq == n.saturating_sub(500).max(1) {
                    ("checkpoint", json!({"upTo":n.saturating_sub(1000),"text":"synthetic checkpoint","unknown":{"keep":true}}))
                } else {
                    ("input", json!({"text":format!("Synthetic row {seq}: {}", "x".repeat(512)),"unknown":{"keep":true}}))
                };
                insert.execute(rusqlite::params![seq as i64,kind,body.to_string()]).unwrap();
            }
        }
        tx.commit().unwrap();
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        println!("prepared {n}"); return;
    }
    if args[2].starts_with("append-") {
        if args[2] == "append-before" { state.call("exec",json!({"sql":"DROP INDEX session_header_overrides"})).unwrap(); }
        state.call("exec",json!({"sql":"PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)"})).unwrap();
        let mut ms = Vec::new();
        for seq in 0..1000 {
            let start = Instant::now();
            state.call("session.append",json!({"id":"ordinary","type":"input","at":"now","body":{"text":format!("Synthetic row {seq}: {}","x".repeat(512))}})).unwrap();
            ms.push(start.elapsed().as_secs_f64()*1000.0);
        }
        ms.sort_by(f64::total_cmp);
        let wal = std::fs::metadata(format!("{}-wal",args[1])).unwrap().len();
        println!("{}",json!({"mode":args[2],"count":1000,"p50Ms":ms[500],"p95Ms":ms[950],"walBytes":wal}));
        return;
    }
    let n = state.call("session.seq", json!({"id":"bench"})).unwrap().as_i64().unwrap()-1;
    let mut ms = Vec::new();
    let mut returned_bytes = 0;
    let mut returned_rows = 0;
    let mut checksum = 0;
    let mut output_hash = 0_u64;
    let reads = std::env::var("TEPORA_HISTORY_BENCH_READS").ok().and_then(|v|v.parse::<usize>().ok()).filter(|n|*n>0).unwrap_or(31);
    for _ in 0..reads {
        let start = Instant::now();
        let entries = state.call(match args[2].as_str() { "page-after" => "session.page", "context-after" => "session.contextEntries", _ => "session.entries" }, json!({"id":"bench","to":if args[2].starts_with("context"){n}else{n-1},"limit":500})).unwrap();
        returned_bytes = entries.to_string().len();
        returned_rows = entries.as_array().unwrap().len();
        let out = if args[2].starts_with("context") {
            let v = view(&entries);
            compute_json("context.build", &json!({"view":v,"system":"synthetic","vision":false,"unicodeVersion":17}).to_string()).unwrap()
        } else if args[2] == "page-before" {
            let a = entries.as_array().unwrap();
            json!(&a[a.len().saturating_sub(500)..]).to_string()
        } else { entries.to_string() };
        checksum = out.len();
        output_hash = out.as_bytes().iter().fold(14695981039346656037_u64, |h,b|(h ^ u64::from(*b)).wrapping_mul(1099511628211));
        ms.push(start.elapsed().as_secs_f64()*1000.0);
    }
    if ms.len()>1 { ms.remove(0); }
    ms.sort_by(f64::total_cmp);
    println!("{}",json!({"mode":args[2],"rows":n,"returnedRows":returned_rows,"returnedSerializedBytes":returned_bytes,"measurements":ms.len(),"p50Ms":ms[ms.len()/2],"p95Ms":ms[(ms.len()*95).div_ceil(100)-1],"outputBytes":checksum,"outputHash":format!("{output_hash:016x}")}));
}
