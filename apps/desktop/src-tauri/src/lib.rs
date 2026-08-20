//! Divisio desktop host — starts the Bun daemon and loads the web UI.
//!
//! The shell is not a second brain: orchestration stays in `apps/server`.
//! Bun must be on PATH (sidecar bundling comes later).

use serde::Deserialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
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

/// Reveal a folder in the file manager, or open it with Cursor / VS Code.
#[tauri::command]
fn open_external(path: String, with: String) -> Result<(), String> {
  let path = PathBuf::from(&path);
  if !path.exists() {
    return Err(format!("path does not exist: {}", path.display()));
  }

  let mut cmd = match with.as_str() {
    "finder" | "reveal" => {
      #[cfg(target_os = "macos")]
      {
        let mut c = Command::new("open");
        c.arg(&path);
        c
      }
      #[cfg(target_os = "windows")]
      {
        let mut c = Command::new("explorer");
        c.arg(&path);
        c
      }
      #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
      {
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
      }
    }
    "cursor" => {
      let mut c = Command::new("cursor");
      c.arg(&path);
      c
    }
    "code" => {
      let mut c = Command::new("code");
      c.arg(&path);
      c
    }
    other => return Err(format!("unknown open target: {other}")),
  };

  match cmd.spawn() {
    Ok(_) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
      Err(format!("{with} CLI not on PATH — install it, then retry"))
    }
    Err(err) => Err(err.to_string()),
  }
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

/// Must match `DAEMON_GENERATION` in packages/contracts/src/protocol.ts.
/// Bump both in the same commit. Command-name substring matching is not a
/// substitute — that is how an older process on :4577 used to get adopted.
const DAEMON_GENERATION: u32 = 2;

#[derive(Deserialize)]
struct Health {
  #[serde(default)]
  generation: Option<u32>,
}

fn health_body() -> Option<String> {
  // Direct TCP — curl honours HTTP_PROXY and is not always on a GUI PATH.
  let addr = SocketAddr::from(([127, 0, 0, 1], DAEMON_PORT));
  let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
  let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
  let req = format!(
    "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{DAEMON_PORT}\r\nConnection: close\r\n\r\n"
  );
  stream.write_all(req.as_bytes()).ok()?;
  let mut buf = Vec::new();
  stream.read_to_end(&mut buf).ok()?;
  parse_health_http(&String::from_utf8_lossy(&buf)).map(str::to_owned)
}

/// Body of a 200 HTTP response, or None.
fn parse_health_http(response: &str) -> Option<&str> {
  let (headers, body) = response
    .split_once("\r\n\r\n")
    .or_else(|| response.split_once("\n\n"))?;
  let status = headers.lines().next()?;
  if !status.contains("200") {
    return None;
  }
  let body = body.trim();
  if body.is_empty() {
    return None;
  }
  Some(body)
}

/// Whether a `/health` JSON body is new enough for this shell to attach.
fn daemon_is_compatible(health_json: &str) -> bool {
  let parsed: Health = match serde_json::from_str(health_json) {
    Ok(v) => v,
    Err(_) => return false,
  };
  parsed
    .generation
    .map(|g| g >= DAEMON_GENERATION)
    .unwrap_or(false)
}

/// Whether a daemon already on the port is new enough to use.
fn existing_daemon_is_compatible() -> bool {
  let Some(body) = health_body() else {
    return false;
  };
  daemon_is_compatible(&body)
}

fn try_read_token() -> Option<String> {
  let token = fs::read_to_string(token_file_path()).ok()?;
  let trimmed = token.trim().to_string();
  if trimmed.is_empty() {
    None
  } else {
    Some(trimmed)
  }
}

fn port_open() -> bool {
  TcpStream::connect(("127.0.0.1", DAEMON_PORT)).is_ok()
}

fn store_token_value(state: &DaemonState, token: String) -> Result<(), String> {
  *state.token.lock().map_err(|e| e.to_string())? = Some(token);
  Ok(())
}

fn adopt_child(state: &DaemonState, child: Child) -> Result<(), String> {
  let token = try_read_token().ok_or_else(|| {
    format!(
      "auth token not found at {} — daemon may have failed to start",
      token_file_path().display()
    )
  })?;
  store_token_value(state, token)?;
  *state.child.lock().map_err(|e| e.to_string())? = Some(child);
  Ok(())
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

fn incompatible_daemon_err() -> String {
  format!(
    "A daemon is already running on port {DAEMON_PORT}, but it reports an older generation \
     than this app needs ({DAEMON_GENERATION}). Stop it (likely an earlier `bun run dev:server`) \
     and reopen Divisio."
  )
}

fn bootstrap_daemon(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<DaemonState>();

  // Attach to a compatible daemon already listening (dev server, leftover
  // sidecar). Do not store a child we did not spawn — window close must not
  // kill someone else's process.
  if existing_daemon_is_compatible() {
    let token = read_token_file()?;
    store_token_value(&state, token)?;
    eprintln!("[divisio] attached to existing daemon on :{DAEMON_PORT}");
    return Ok(());
  }

  if port_open() {
    if health_body().is_some() {
      return Err(incompatible_daemon_err());
    }
    return Err(format!(
      "Port {DAEMON_PORT} is in use by a process this app cannot attach to. \
       Stop that process and reopen Divisio."
    ));
  }

  let mut child = start_daemon()?;
  let start = Instant::now();
  let timeout = Duration::from_secs(20);
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        // Our spawn exited. Only attach if a compatible listener remains;
        // otherwise we used to print "daemon ready" against the old port.
        if existing_daemon_is_compatible() {
          let token = read_token_file()?;
          store_token_value(&state, token)?;
          eprintln!("[divisio] attached to existing daemon on :{DAEMON_PORT}");
          return Ok(());
        }
        return Err(format!(
          "daemon exited before becoming healthy ({status}). \
           Port {DAEMON_PORT} is likely already in use."
        ));
      }
      Ok(None) => {
        // We spawned this process. If it bound the port, keep it — do not wait
        // on /health (that used to hang, then kill a live daemon, and the UI
        // flashed Connected → Disconnected).
        let bound = port_open() && try_read_token().is_some();
        if bound && start.elapsed() >= Duration::from_millis(400) {
          adopt_child(&state, child)?;
          return Ok(());
        }
        if start.elapsed() > timeout {
          if bound {
            adopt_child(&state, child)?;
            return Ok(());
          }
          let _ = child.kill();
          let _ = child.wait();
          return Err("daemon did not become healthy on 127.0.0.1:4577".into());
        }
      }
      Err(e) => {
        let _ = child.kill();
        return Err(format!("failed to poll daemon: {e}"));
      }
    }
    thread::sleep(Duration::from_millis(150));
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(DaemonState {
      child: Mutex::new(None),
      token: Mutex::new(None),
    })
    .invoke_handler(tauri::generate_handler![auth_token, daemon_ready, open_external])
    .setup(|app| {
      match bootstrap_daemon(app.handle()) {
        Ok(()) => eprintln!("[divisio] daemon ready"),
        Err(err) => {
          eprintln!("[divisio] daemon bootstrap failed: {err}");
          // Still show the window — the UI can surface the error via missing token.
        }
      }

      // Wallpaper bleed: native under-window vibrancy behind a transparent webview.
      // CSS frost alone cannot show the desktop; this is the AppKit material.
      #[cfg(target_os = "macos")]
      {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        if let Some(window) = app.get_webview_window("main") {
          if let Err(err) = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::UnderWindowBackground,
            None,
            None,
          ) {
            eprintln!("[divisio] vibrancy unavailable: {err}");
          }
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

#[cfg(test)]
mod tests {
  use super::{daemon_is_compatible, parse_health_http, DAEMON_GENERATION};

  #[test]
  fn missing_generation_is_incompatible_even_when_command_names_appear() {
    assert!(!daemon_is_compatible(
      r#"{"ok":true,"commands":["project.remove","turn.restore","file.tree"]}"#
    ));
  }

  #[test]
  fn current_generation_is_compatible() {
    let body = format!(r#"{{"ok":true,"generation":{DAEMON_GENERATION},"commands":[]}}"#);
    assert!(daemon_is_compatible(&body));
  }

  #[test]
  fn newer_generation_is_compatible() {
    let body = format!(r#"{{"ok":true,"generation":{}}}"#, DAEMON_GENERATION + 1);
    assert!(daemon_is_compatible(&body));
  }

  #[test]
  fn older_generation_is_incompatible() {
    assert!(!daemon_is_compatible(r#"{"ok":true,"generation":0}"#));
  }

  #[test]
  fn garbage_json_is_incompatible() {
    assert!(!daemon_is_compatible("not json"));
  }

  #[test]
  fn parse_health_http_reads_json_body() {
    let raw = concat!(
      "HTTP/1.1 200 OK\r\n",
      "content-type: application/json\r\n",
      "\r\n",
      "{\"ok\":true,\"generation\":2}\n"
    );
    assert_eq!(parse_health_http(raw), Some("{\"ok\":true,\"generation\":2}"));
  }

  #[test]
  fn parse_health_http_rejects_non_200() {
    assert!(parse_health_http("HTTP/1.1 404 Not Found\r\n\r\n{}").is_none());
  }
}
