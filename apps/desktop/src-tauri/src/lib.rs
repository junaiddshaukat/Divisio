//! Divisio desktop host — starts the Bun daemon and loads the web UI.
//!
//! The shell is not a second brain: orchestration stays in `apps/server`.
//! Bun must be on PATH (sidecar bundling comes later).

use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const DAEMON_PORT: u16 = 4577;

struct DaemonState {
  child: Mutex<Option<Child>>,
  token: Mutex<Option<String>>,
}

#[tauri::command]
fn auth_token(state: State<'_, DaemonState>) -> Result<String, String> {
  state
    .token
    .lock()
    .map_err(|e| e.to_string())?
    .clone()
    .ok_or_else(|| "daemon token not ready".into())
}

#[tauri::command]
fn daemon_ready(state: State<'_, DaemonState>) -> bool {
  state.token.lock().map(|g| g.is_some()).unwrap_or(false)
}

fn repo_root() -> Option<PathBuf> {
  // Only meaningful in a dev checkout. A packaged app has no monorepo, so this
  // returning None is normal rather than an error.
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .ok()
}

/// The bundled daemon binary, which Tauri places beside the app executable.
/// Present in a packaged build, absent when running `tauri dev`.
fn sidecar_path() -> Option<PathBuf> {
  let exe = std::env::current_exe().ok()?;
  let candidate = exe.parent()?.join("divisio-daemon");
  candidate.exists().then_some(candidate)
}

fn token_file_path() -> PathBuf {
  dirs_home()
    .join(".divisio")
    .join("userdata")
    .join("auth-token")
}

fn dirs_home() -> PathBuf {
  std::env::var_os("HOME")
    .or_else(|| std::env::var_os("USERPROFILE"))
    .map(PathBuf::from)
    .expect("HOME")
}

fn wait_for_health(timeout: Duration) -> bool {
  let start = Instant::now();
  while start.elapsed() < timeout {
    if TcpStream::connect(("127.0.0.1", DAEMON_PORT)).is_ok() {
      // Prefer HTTP health when the port accepts connections.
      if let Ok(out) = Command::new("curl")
        .args([
          "-fsS",
          "--max-time",
          "1",
          &format!("http://127.0.0.1:{DAEMON_PORT}/health"),
        ])
        .output()
      {
        if out.status.success() {
          return true;
        }
      } else {
        // curl missing — TCP accept is good enough after a short settle.
        thread::sleep(Duration::from_millis(200));
        return true;
      }
    }
    thread::sleep(Duration::from_millis(150));
  }
  false
}

fn start_daemon() -> Result<Child, String> {
  let origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
  ]
  .join(",");

  // Prefer the bundled binary; fall back to running from source in a dev
  // checkout. A packaged app must never depend on Bun being installed.
  let mut command = match sidecar_path() {
    Some(bin) => {
      eprintln!("[divisio] starting bundled daemon: {}", bin.display());
      Command::new(bin)
    }
    None => {
      let repo = repo_root().ok_or_else(|| {
        "no bundled daemon and no source checkout to run from".to_string()
      })?;
      let entry = repo.join("apps/server/src/index.ts");
      if !entry.exists() {
        return Err(format!("daemon entry missing: {}", entry.display()));
      }
      eprintln!("[divisio] starting daemon from source (dev)");
      let mut c = Command::new("bun");
      c.arg("run").arg(&entry).current_dir(&repo);
      c
    }
  };

  let mut child = command
    .env("DIVISIO_DEV_ORIGINS", origins)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("failed to start the Divisio daemon: {e}"))?;

  // Drain stderr so the pipe does not fill and stall the child.
  if let Some(stderr) = child.stderr.take() {
    thread::spawn(move || {
      let reader = BufReader::new(stderr);
      for line in reader.lines().flatten() {
        eprintln!("[daemon] {line}");
      }
    });
  }
  if let Some(stdout) = child.stdout.take() {
    thread::spawn(move || {
      let reader = BufReader::new(stdout);
      for line in reader.lines().flatten() {
        eprintln!("[daemon] {line}");
      }
    });
  }

  Ok(child)
}

fn read_token_file() -> Result<String, String> {
  let path = token_file_path();
  let start = Instant::now();
  while start.elapsed() < Duration::from_secs(10) {
    if path.exists() {
      let token = fs::read_to_string(&path).map_err(|e| e.to_string())?;
      let trimmed = token.trim().to_string();
      if !trimmed.is_empty() {
        return Ok(trimmed);
      }
    }
    thread::sleep(Duration::from_millis(100));
  }
  Err(format!(
    "auth token not found at {} — daemon may have failed to start",
    path.display()
  ))
}

fn bootstrap_daemon(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<DaemonState>();

  // Reuse a daemon already listening (e.g. `bun run dev:server`).
  if wait_for_health(Duration::from_secs(1)) {
    let token = read_token_file()?;
    *state.token.lock().map_err(|e| e.to_string())? = Some(token);
    eprintln!("[divisio] attached to existing daemon on :{DAEMON_PORT}");
    return Ok(());
  }

  let child = start_daemon()?;
  *state.child.lock().map_err(|e| e.to_string())? = Some(child);

  if !wait_for_health(Duration::from_secs(20)) {
    return Err("daemon did not become healthy on 127.0.0.1:4577".into());
  }

  let token = read_token_file()?;
  *state.token.lock().map_err(|e| e.to_string())? = Some(token);
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(DaemonState {
      child: Mutex::new(None),
      token: Mutex::new(None),
    })
    .invoke_handler(tauri::generate_handler![auth_token, daemon_ready])
    .setup(|app| {
      match bootstrap_daemon(app.handle()) {
        Ok(()) => eprintln!("[divisio] daemon ready"),
        Err(err) => {
          eprintln!("[divisio] daemon bootstrap failed: {err}");
          // Still show the window — the UI can surface the error via missing token.
        }
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        if let Some(state) = window.try_state::<DaemonState>() {
          if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
              let _ = child.wait();
            }
          }
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running Divisio");
}
