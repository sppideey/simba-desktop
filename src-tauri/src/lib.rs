//! Simba Desktop — the native shell.
//!
//! Its one real job beyond hosting the webview is owning the agent sidecar:
//! a Node process running `sidecar/server.js`, which drives the same Agent the
//! `simba` CLI drives. Lines of JSON go in on stdin and come out on stdout;
//! this file is the pipe between that process and the React front end.
//!
//! Spawning is done here rather than through the shell plugin so stdin stays
//! open for the life of the session and credentials can be passed through the
//! child's environment — never through a message that could reach a log.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Agent {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// Shut the sidecar down. Dropping stdin closes the agent's readline so it
/// exits cleanly; the kill is only for a process that ignored that.
fn stop_agent(agent: &Agent) {
    agent.stdin.lock().unwrap().take();
    if let Some(mut child) = agent.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Absolute path to sidecar/server.js.
///
/// It must be absolute: the child runs with the user's project as its working
/// directory, so a relative path would be looked up inside *their* folder.
/// In development the sidecar sits beside the crate; in a bundled app it ships
/// next to the executable as a resource.
fn sidecar_script() -> Result<std::path::PathBuf, String> {
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("server.js");
    if dev.exists() {
        return dev.canonicalize().map_err(|e| e.to_string());
    }

    let exe_dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("the executable has no parent directory")?
        .to_path_buf();

    // Bundled: shipped as a resource by tauri.conf.json, alongside a real
    // node_modules so `import 'simba-agent/agent.js'` resolves.
    for candidate in [
        exe_dir.join("sidecar-dist").join("server.js"),
        exe_dir
            .join("resources")
            .join("sidecar-dist")
            .join("server.js"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("the agent sidecar was not found next to the app".into())
}

/// The Node binary to run the agent with.
///
/// A copy ships inside the installer, so Code mode works on a machine that has
/// never had Node installed. The bundled one is preferred over whatever is on
/// PATH: it is a known version, and it cannot be shadowed by something older.
/// Falling back to "node" keeps `pnpm app` working in development, where
/// nothing has been staged yet.
fn node_binary() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join("sidecar-dist").join("node.exe"),
                dir.join("resources").join("sidecar-dist").join("node.exe"),
            ] {
                if candidate.exists() {
                    return candidate;
                }
            }
        }
    }
    std::path::PathBuf::from("node")
}

/// Start the sidecar for one project folder.
///
/// `on_event` receives every line the agent emits, verbatim, so the front end
/// owns all parsing. Restarting is safe: any previous child is killed first.
#[tauri::command]
fn agent_start(
    state: State<'_, Agent>,
    cwd: String,
    openrouter_key: String,
    tavily_key: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    stop_agent(&state);

    let script = sidecar_script()?;

    let mut command = Command::new(node_binary());
    command
        .arg(&script)
        .arg(&cwd)
        .current_dir(&cwd)
        .env("OPENROUTER_API_KEY", openrouter_key)
        // Scaffolding a whole app is dozens of writes before anything runs;
        // the CLI default of 50 stops halfway through and looks like giving up.
        .env("SIMBA_MAX_STEPS", "200")
        // The agent boots on north-mini-code; lightning activates 3B params
        // against its 12B, which is the difference between a pause and a wait.
        .env("SIMBA_MODEL", "nvidia/nemotron-3.5-lightning:free")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !tavily_key.is_empty() {
        command.env("TAVILY_API_KEY", tavily_key);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|e| {
        format!("Could not start the agent: {e}")
    })?;

    let stdout = child.stdout.take().ok_or("the agent produced no stdout")?;
    let stderr = child.stderr.take().ok_or("the agent produced no stderr")?;
    *state.stdin.lock().unwrap() = child.stdin.take();

    let out_channel = on_event.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if out_channel.send(line).is_err() {
                break; // the window went away
            }
        }
    });

    // A crash writes to stderr, not stdout. Forwarding it as a structured error
    // is the difference between a visible failure and a silent hang.
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let payload = serde_json::json!({
                "type": "stderr",
                "text": line,
            });
            if on_event.send(payload.to_string()).is_err() {
                break;
            }
        }
    });

    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

/// Write one command line to the agent's stdin.
#[tauri::command]
fn agent_send(state: State<'_, Agent>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("the agent is not running")?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_stop(state: State<'_, Agent>) -> Result<(), String> {
    stop_agent(&state);
    Ok(())
}

/// Whether Node is present, so Code mode can explain itself instead of failing.
#[tauri::command]
fn node_version() -> Option<String> {
    let mut command = Command::new(node_binary());
    command.arg("--version");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command.output().ok().and_then(|out| {
        if out.status.success() {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            None
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Agent::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            agent_start,
            agent_send,
            agent_stop,
            node_version
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
