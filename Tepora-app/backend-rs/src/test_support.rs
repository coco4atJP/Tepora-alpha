use parking_lot::Mutex;

pub static ENV_LOCK: Mutex<()> = Mutex::new(());
