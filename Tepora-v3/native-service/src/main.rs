use std::{
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tepora_native_service::{
    http::{HttpConfig, Server},
    workspace::Workspace,
    ApiError, Backend, VERSION,
};
use tokio::sync::mpsc;

fn data_dir() -> PathBuf {
    if let Some(dir) = env::var_os("TEPORA_DATA_DIR") {
        return dir.into();
    }
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("Tepora")
            .join("v3")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Tepora/v3")
    } else {
        home.join(".local/share/tepora-v3")
    }
}
struct Options {
    data: PathBuf,
    web: PathBuf,
    bundle: PathBuf,
    port: u16,
    sidecar: bool,
    open: bool,
}
fn options() -> Result<Options, ApiError> {
    let mut data = data_dir();
    let mut web = env::var_os("TEPORA_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web"));
    let mut bundle = env::var_os("TEPORA_BUNDLE_PATH").map(PathBuf::from);
    let mut port = env::var("TEPORA_PORT")
        .unwrap_or_else(|_| "0".into())
        .parse::<u16>()
        .map_err(|_| ApiError::bad_request("Invalid TEPORA_PORT"))?;
    let (mut dev, mut sidecar, mut open) = (false, false, false);
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str(){
  "--dev-native"=>dev=true,"--sidecar"=>sidecar=true,"--open"=>open=true,
  "--data-dir"=>data=PathBuf::from(args.next().ok_or_else(||ApiError::bad_request("--data-dir requires a path"))?),
  "--web-dir"=>web=PathBuf::from(args.next().ok_or_else(||ApiError::bad_request("--web-dir requires a path"))?),
  "--bundle"=>bundle=Some(PathBuf::from(args.next().ok_or_else(||ApiError::bad_request("--bundle requires a path"))?)),
  "--port"=>port=args.next().ok_or_else(||ApiError::bad_request("--port requires a number"))?.parse().map_err(|_|ApiError::bad_request("Invalid port"))?,
  "--help"|"-h"=>return Err(ApiError::new(400,"Development service: --dev-native [--sidecar] [--open] [--port N] [--data-dir PATH] [--web-dir PATH] [--bundle PATH]")),
  _=>return Err(ApiError::bad_request(format!("Unknown argument: {arg}"))),
 }
    }
    if !dev {
        return Err(ApiError::bad_request("This service is developmental. Pass --dev-native explicitly; normal Tepora launch still preserves the full application."));
    }
    let bundle = bundle.unwrap_or_else(|| web.join("app.bundle.js"));
    Ok(Options {
        data,
        web,
        bundle,
        port,
        sidecar,
        open,
    })
}
#[derive(Debug)]
enum SidecarCommand {
    Stop,
    Shutdown,
}
fn sidecar_input() -> mpsc::Receiver<SidecarCommand> {
    let (tx, rx) = mpsc::channel(8);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = Vec::<u8>::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = tx.blocking_send(SidecarCommand::Shutdown);
                    break;
                }
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    if buffer.len() > 4096 {
                        buffer.drain(..buffer.len() - 4096);
                    }
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let line = String::from_utf8_lossy(&buffer[..end]).trim().to_owned();
                        buffer.drain(..=end);
                        match line.as_str() {
                            "shutdown" => {
                                let _ = tx.blocking_send(SidecarCommand::Shutdown);
                                return;
                            }
                            "stop" => {
                                if tx.blocking_send(SidecarCommand::Stop).is_err() {
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    });
    rx
}
fn signal_task(
    shutdown: tokio::sync::watch::Sender<bool>,
) -> Result<tokio::task::JoinHandle<()>, ApiError> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .map_err(|e| ApiError::new(500, e.to_string()))?;
        Ok(tokio::spawn(async move {
            tokio::select! {_=interrupt.recv()=>{},_=term.recv()=>{}}
            shutdown.send_replace(true);
        }))
    }
    #[cfg(windows)]
    {
        let mut interrupt =
            tokio::signal::windows::ctrl_c().map_err(|e| ApiError::new(500, e.to_string()))?;
        Ok(tokio::spawn(async move {
            interrupt.recv().await;
            shutdown.send_replace(true);
        }))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown.send_replace(true);
        }))
    }
}
fn open_browser(url: &str) {
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else {
        std::process::Command::new("xdg-open")
    };
    if command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_err()
    {
        eprintln!("Open the readiness URL in a browser.");
    }
}
async fn run() -> Result<(), ApiError> {
    let options = options()?;
    // Fail before acquiring a state lease when build-time browser assets are absent.
    std::fs::read(&options.bundle).map_err(|e| {
        ApiError::new(
            500,
            format!(
                "Prebuilt browser bundle is required at {}: {e}",
                options.bundle.display()
            ),
        )
    })?;
    let backend: Arc<dyn Backend> = Arc::new(Workspace::open(&options.data)?);
    let mut config = HttpConfig::new(options.web, options.bundle);
    config.port = options.port;
    let server = match Server::bind(config, backend.clone()).await {
        Ok(server) => server,
        Err(error) => {
            let _ = backend.shutdown();
            return Err(error);
        }
    };
    let url = server.launch_url();
    let shutdown = server.shutdown_sender();
    // Install handlers before announcing readiness, including immediate tray quit.
    let signal_task = match signal_task(shutdown.clone()) {
        Ok(task) => task,
        Err(error) => {
            let _ = backend.shutdown();
            return Err(error);
        }
    };
    println!(
        "{}",
        serde_json::json!({"type":"ready","url":url,"version":VERSION,"mode":"native-workspace-development"})
    );
    std::io::stdout()
        .flush()
        .map_err(|e| ApiError::new(500, e.to_string()))?;
    if options.open {
        open_browser(&url);
    }
    let sidecar = options.sidecar.then(sidecar_input);
    let command_backend = backend.clone();
    let command_shutdown = shutdown.clone();
    let command_task = sidecar.map(|mut commands| {
        tokio::spawn(async move {
            while let Some(command) = commands.recv().await {
                match command {
                    SidecarCommand::Shutdown => {
                        command_shutdown.send_replace(true);
                        break;
                    }
                    SidecarCommand::Stop => {
                        let backend = command_backend.clone();
                        match tokio::task::spawn_blocking(move || backend.stop()).await {
                            Ok(Ok(())) => {}
                            Ok(Err(e)) => eprintln!("Tepora stop: {e}"),
                            Err(e) => eprintln!("Tepora stop task: {e}"),
                        }
                    }
                }
            }
        })
    });
    let result = server.run().await;
    shutdown.send_replace(true);
    signal_task.abort();
    if let Some(task) = command_task {
        task.abort();
    }
    let closed = tokio::task::spawn_blocking(move || backend.shutdown())
        .await
        .map_err(|e| ApiError::new(500, e.to_string()))?;
    result?;
    closed
}
fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .expect("Tokio runtime");
    let result = runtime.block_on(run());
    runtime.shutdown_timeout(Duration::from_secs(5));
    if let Err(error) = result {
        eprintln!("Tepora native service: {error}");
        std::process::exit(1);
    }
}
