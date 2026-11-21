// MissionPilot — Tauri shell (P3).
// The board frontend talks to the local backend over HTTP (127.0.0.1:8788).
// This shell manages the backend as a child process: start_backend spawns
// `node <backend.js> --http` with a fresh bearer token, and the child is
// killed when the app exits. The backend JS is resolved in order:
//   1. explicit path passed from the setup screen
//   2. <resource_dir>/backend/server.js (packaged Mac .app)
//   3. ../../../../dist/src/server.js relative to the exe (dev layout)
// Node comes from PATH on the Mac (the user is a developer with node);
// bundling a node binary into the .app is a later packaging step.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

struct AppState {
    backend_child: Mutex<Option<Child>>,
    token: Mutex<Option<String>>,
}

fn fresh_token() -> String {
    // 16 bytes from /dev/urandom, hex-encoded. No extra crates.
    let bytes = fs::read("/dev/urandom").unwrap_or_else(|_| vec![0u8; 16]);
    bytes.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn backend_listening() -> bool {
    let addr: SocketAddr = "127.0.0.1:8788".parse().expect("static addr parses");
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

fn resolve_backend_js(app: &AppHandle, explicit: Option<String>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        let packaged = res_dir.join("backend").join("server.js");
        if packaged.exists() {
            return Some(packaged);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // exe is .../src-tauri/target/debug/<bin>; dev backend is at
            // repo root dist/src/server.js (five levels up from debug/).
            let dev = dir.join("../../../../../dist/src/server.js");
            if dev.exists() {
                return Some(dev);
            }
        }
    }
    None
}

#[tauri::command]
fn backend_status() -> serde_json::Value {
    let running = backend_listening();
    // TEMP DEBUG (white window): every command call is logged to the
    // `npm run tauri dev` terminal so a blank window can be traced.
    eprintln!("[mission-pilot] backend_status -> running={running}");
    serde_json::json!({ "running": running })
}

#[tauri::command]
fn get_token(state: State<'_, AppState>) -> Option<String> {
    let tok = state.token.lock().ok().and_then(|t| t.clone());
    eprintln!("[mission-pilot] get_token -> {}", if tok.is_some() { "some" } else { "none" });
    tok
}

/// Token for a backend the user started themselves (e.g. in a terminal):
/// if ORCHESTRATOR_MCP_TOKEN is in this process's environment, the app
/// can connect without the user pasting it.
#[tauri::command]
fn get_env_token() -> Option<String> {
    let tok = std::env::var("ORCHESTRATOR_MCP_TOKEN").ok().filter(|t| !t.trim().is_empty());
    eprintln!("[mission-pilot] get_env_token -> {}", if tok.is_some() { "some" } else { "none" });
    tok
}

/// Path the app would use when the Backend JS field is left blank
/// (explicit path → packaged → dev layout, same as resolve_backend_js).
#[tauri::command]
fn resolve_backend_path(app: AppHandle) -> Option<String> {
    let p = resolve_backend_js(&app, None).map(|p| p.to_string_lossy().to_string());
    eprintln!("[mission-pilot] resolve_backend_path -> {p:?}");
    p
}

/// Find the node binary: PATH first, then the usual macOS install spots.
/// (An app launched outside a terminal can have a bare PATH; relying on
/// `Command::new("node")` alone fails silently there.)
fn resolve_node() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let cand = PathBuf::from(dir).join("node");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    for cand in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        let p = PathBuf::from(cand);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
fn start_backend(
    app: AppHandle,
    state: State<'_, AppState>,
    backend_js: Option<String>,
) -> Result<String, String> {
    eprintln!("[mission-pilot] start_backend called, explicit={backend_js:?}");
    if backend_listening() {
        // Already running (e.g. started externally); hand back the known
        // token if we spawned it, else the caller must paste one.
        if let Ok(t) = state.token.lock() {
            if let Some(tok) = t.clone() {
                return Ok(tok);
            }
        }
        return Err("backend already running, but this app did not start it — paste its token instead".to_string());
    }
    let js = resolve_backend_js(&app, backend_js)
        .ok_or_else(|| "backend server.js not found (pass its path in the setup screen)".to_string())?;
    eprintln!("[mission-pilot] start_backend: resolved js={}", js.display());
    let node = resolve_node().ok_or_else(|| {
        eprintln!("[mission-pilot] start_backend: node not found (searched PATH, /opt/homebrew/bin/node, /usr/local/bin/node)");
        "node not found (searched PATH, /opt/homebrew/bin/node, /usr/local/bin/node) — install node or start the backend yourself".to_string()
    })?;
    eprintln!("[mission-pilot] start_backend: using node={}", node.display());
    let token = fresh_token();
    // Keep the backend's stderr so a crash at startup is diagnosable
    // instead of vanishing into Stdio::null().
    let err_log = std::env::temp_dir().join("mission-pilot-backend.log");
    let err_stdio = std::fs::File::create(&err_log)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    eprintln!("[mission-pilot] start_backend: backend stderr -> {}", err_log.display());
    let child = Command::new(&node)
        .arg(&js)
        .arg("--http")
        .env("ORCHESTRATOR_TRANSPORT", "http")
        .env("ORCHESTRATOR_MCP_TOKEN", &token)
        .env("ORCHESTRATOR_HTTP_PORT", "8788")
        .stdout(Stdio::null())
        .stderr(err_stdio)
        .spawn()
        .map_err(|e| {
            eprintln!("[mission-pilot] start_backend: failed to spawn node: {e}");
            format!("failed to spawn node: {e}")
        })?;
    eprintln!("[mission-pilot] start_backend: spawned node pid={}", child.id());
    if let Ok(mut slot) = state.backend_child.lock() {
        *slot = Some(child);
    }
    // Wait for the backend to start listening (up to 10s).
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if backend_listening() {
            if let Ok(mut t) = state.token.lock() {
                *t = Some(token.clone());
            }
            eprintln!("[mission-pilot] start_backend: backend listening, token stored");
            return Ok(token);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("[mission-pilot] start_backend: backend did NOT start listening within 10s");
    if let Ok(mut slot) = state.backend_child.lock() {
        if let Some(mut c) = slot.take() {
            let _ = c.kill();
        }
    }
    Err("backend did not start listening on 127.0.0.1:8788 within 10s".to_string())
}

fn main() {
    let state = AppState {
        backend_child: Mutex::new(None),
        token: Mutex::new(None),
    };
    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            backend_status,
            get_token,
            get_env_token,
            resolve_backend_path,
            start_backend
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tauri app");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(mut slot) = state.backend_child.lock() {
                    if let Some(mut child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
