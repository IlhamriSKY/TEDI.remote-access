//! TEDI remote-access agent.
//!
//! Spawned by the `tedi.remote-access` extension via `shell_bg_spawn_direct`.
//! It mirrors every live PTY daemon session and bridges them to a self-hosted
//! relay over a single outbound WSS connection, so a browser anywhere can
//! attach to the terminals you have open in TEDI. See README.md.
//!
//! Data flow:
//!   PTY daemon  --(named pipe)-->  AGENT  --(outbound WSS)-->  relay  -->  browser
//!
//! stdout is reserved for the one-line `READY {json}` handshake the extension
//! reads via `shell_bg_logs`. All logging goes to stderr.

mod daemon;
mod wire;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use daemon::{DaemonClient, DaemonEvent};
use wire::SessionInfo;

/// Per-session rolling buffer the agent keeps so a browser that connects (or
/// reconnects) gets immediate scrollback without re-attaching the daemon.
const RING_CAP: usize = 256 * 1024;

struct SessionState {
    info: SessionInfo,
    ring: VecDeque<u8>,
}

type Sessions = Arc<Mutex<HashMap<Uuid, SessionState>>>;
/// The sender for the CURRENTLY connected relay socket, or None when down.
type RelayTx = Arc<Mutex<Option<mpsc::Sender<Message>>>>;

struct Config {
    relay_url: String,
    token: String,
    name: String,
    pipe_name: String,
}

/// FNV-1a, matching TEDI's `pty_daemon::paths::fnv1a` (the Windows pipe-name
/// suffix). Only the Windows socket name uses it.
#[cfg(windows)]
fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The daemon endpoint TEDI listens on, derived exactly like TEDI's
/// `pty_daemon::paths` so the agent attaches to the same socket on every OS:
///   - Windows: a kernel-namespaced pipe `tedi-ptyd-<fnv1a(USERNAME)>`.
///   - Unix: a filesystem socket `$XDG_RUNTIME_DIR/tedi-ptyd.sock`, falling back
///     to `$TMPDIR/tedi-ptyd-<USER>.sock` (or `/tmp`).
#[cfg(windows)]
fn default_socket() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!("tedi-ptyd-{:08x}", fnv1a(user.as_bytes()))
}

#[cfg(unix)]
fn default_socket() -> String {
    use std::path::PathBuf;
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir)
            .join("tedi-ptyd.sock")
            .to_string_lossy()
            .into_owned();
    }
    let tmp = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    tmp.join(format!("tedi-ptyd-{user}.sock"))
        .to_string_lossy()
        .into_owned()
}

fn load_config() -> Result<Config, String> {
    // argv[1] is either inline JSON ({"relay_url":..}) or a path to such a
    // JSON file. The extension passes inline JSON via shell_bg_spawn_direct.
    if let Some(arg) = std::env::args().nth(1) {
        let txt = if arg.trim_start().starts_with('{') {
            arg
        } else {
            std::fs::read_to_string(&arg).map_err(|e| format!("read config {arg}: {e}"))?
        };
        let v: Value = serde_json::from_str(&txt).map_err(|e| format!("parse config: {e}"))?;
        return Ok(Config {
            relay_url: v
                .get("relay_url")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "config.relay_url missing".to_string())?
                .to_string(),
            token: v
                .get("agent_token")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "config.agent_token missing".to_string())?
                .to_string(),
            name: v
                .get("agent_name")
                .and_then(|x| x.as_str())
                .unwrap_or("tedi-host")
                .to_string(),
            pipe_name: v
                .get("pipe_name")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(default_socket),
        });
    }
    Ok(Config {
        relay_url: std::env::var("TEDI_RELAY_URL").map_err(|_| "TEDI_RELAY_URL not set".to_string())?,
        token: std::env::var("TEDI_AGENT_TOKEN").map_err(|_| "TEDI_AGENT_TOKEN not set".to_string())?,
        name: std::env::var("TEDI_AGENT_NAME").unwrap_or_else(|_| "tedi-host".into()),
        pipe_name: std::env::var("TEDI_PIPE_NAME").unwrap_or_else(|_| default_socket()),
    })
}

fn title_of(info: &SessionInfo) -> String {
    info.cwd
        .as_deref()
        .map(|c| {
            c.trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(c)
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "shell".into())
}

fn send_relay(tx: &RelayTx, msg: Message) {
    if let Some(s) = tx.lock().unwrap().as_ref() {
        let _ = s.try_send(msg); // drop on backpressure/disconnect; browser refetches
    }
}

fn sessions_frame(sessions: &Sessions) -> Message {
    let items: Vec<Value> = sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| {
            json!({
                "id": s.info.id,
                "cwd": s.info.cwd,
                "cols": s.info.cols,
                "rows": s.info.rows,
                "alive": s.info.alive,
                "title": title_of(&s.info),
            })
        })
        .collect();
    Message::text(json!({ "t": "sessions", "items": items }).to_string())
}

fn attached_frames(sessions: &Sessions) -> Vec<Message> {
    sessions
        .lock()
        .unwrap()
        .values()
        .map(|s| {
            let bytes: Vec<u8> = s.ring.iter().copied().collect();
            Message::text(
                json!({
                    "t": "attached",
                    "id": s.info.id,
                    "scrollback": B64.encode(&bytes),
                    "cols": s.info.cols,
                    "rows": s.info.rows,
                    "alive": s.info.alive,
                })
                .to_string(),
            )
        })
        .collect()
}

fn parse_uuid(v: &Value) -> Option<Uuid> {
    v.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

async fn handle_browser_frame(
    text: &str,
    daemon: &Arc<DaemonClient>,
    sessions: &Sessions,
    relay_tx: &RelayTx,
) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("t").and_then(|x| x.as_str()).unwrap_or("") {
        "input" => {
            if let (Some(id), Some(b64)) = (
                v.get("id").and_then(parse_uuid),
                v.get("b64").and_then(|x| x.as_str()),
            ) {
                // b64 is base64 of the raw keystroke bytes; forward as-is.
                if let Err(e) = daemon.write(id, b64.to_string()).await {
                    eprintln!("[agent] write to {id} failed: {e}");
                }
            }
        }
        "resize" => {
            // MVP: size-follow the host (remote does not resize the PTY, which
            // would reflow the GUI pane). v2 may honor this with a policy.
        }
        "open" => {
            // "New tab from the browser": ask the daemon to spawn a fresh PTY.
            // Spawn the request so the slow daemon-side openpty/spawn (hundreds
            // of ms on Windows) doesn't stall reading further browser frames.
            // The 2s discovery poll then attaches + mirrors the new session.
            let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(80) as u16;
            let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(24) as u16;
            let cwd = v.get("cwd").and_then(|x| x.as_str()).map(|s| s.to_string());
            let daemon = daemon.clone();
            tokio::spawn(async move {
                match daemon.open(cols, rows, cwd).await {
                    Ok(id) => eprintln!("[agent] opened new session {id} ({cols}x{rows})"),
                    Err(e) => eprintln!("[agent] open failed: {e}"),
                }
            });
        }
        "ping" => send_relay(relay_tx, Message::text(json!({ "t": "pong" }).to_string())),
        "hello" | "client_join" => {
            // A browser (re)joined: replay current state.
            send_relay(relay_tx, sessions_frame(sessions));
            for m in attached_frames(sessions) {
                send_relay(relay_tx, m);
            }
        }
        _ => {}
    }
}

#[tokio::main]
async fn main() {
    let cfg = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[agent] config error: {e}");
            std::process::exit(1);
        }
    };

    // READY handshake for the extension (stdout only).
    println!(
        "READY {}",
        json!({
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "name": cfg.name,
        })
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();
    eprintln!("[agent] relay={} pipe={}", cfg.relay_url, cfg.pipe_name);

    // Daemon connection + event stream.
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<DaemonEvent>();
    let daemon = match DaemonClient::connect(&cfg.pipe_name, ev_tx) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[agent] daemon connect failed: {e}");
            std::process::exit(2);
        }
    };

    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let relay_tx: RelayTx = Arc::new(Mutex::new(None));

    // Pump: daemon Data/Exit -> ring buffer + relay frames.
    {
        let sessions = sessions.clone();
        let relay_tx = relay_tx.clone();
        tokio::spawn(async move {
            while let Some(ev) = ev_rx.recv().await {
                match ev {
                    DaemonEvent::Data { id, b64 } => {
                        if let Ok(bytes) = B64.decode(b64.as_bytes()) {
                            let mut map = sessions.lock().unwrap();
                            if let Some(st) = map.get_mut(&id) {
                                st.ring.extend(bytes.iter().copied());
                                while st.ring.len() > RING_CAP {
                                    st.ring.pop_front();
                                }
                            }
                        }
                        send_relay(
                            &relay_tx,
                            Message::text(json!({ "t": "data", "id": id, "b64": b64 }).to_string()),
                        );
                    }
                    DaemonEvent::Exit { id, code } => {
                        if let Some(st) = sessions.lock().unwrap().get_mut(&id) {
                            st.info.alive = false;
                        }
                        send_relay(
                            &relay_tx,
                            Message::text(json!({ "t": "exit", "id": id, "code": code }).to_string()),
                        );
                    }
                }
            }
        });
    }

    // Poll: discover new/closed panels every 2s, attach new ones.
    {
        let daemon = daemon.clone();
        let sessions = sessions.clone();
        let relay_tx = relay_tx.clone();
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                let items = match daemon.list().await {
                    Ok(i) => i,
                    Err(e) => {
                        eprintln!("[agent] list error: {e}");
                        continue;
                    }
                };
                let live: HashSet<Uuid> = items.iter().map(|s| s.id).collect();
                let mut changed = false;

                for it in &items {
                    if !it.alive {
                        continue;
                    }
                    let known = sessions.lock().unwrap().contains_key(&it.id);
                    if known {
                        let mut map = sessions.lock().unwrap();
                        if let Some(st) = map.get_mut(&it.id) {
                            if st.info.cols != it.cols
                                || st.info.rows != it.rows
                                || !st.info.alive
                            {
                                st.info = it.clone();
                                changed = true;
                            }
                        }
                        continue;
                    }
                    // New live session — attach as a second subscriber.
                    match daemon.attach(it.id, it.cols, it.rows).await {
                        Ok((sb, _alive)) => {
                            let bytes = B64.decode(sb.as_bytes()).unwrap_or_default();
                            let start = bytes.len().saturating_sub(RING_CAP);
                            let ring: VecDeque<u8> = bytes[start..].iter().copied().collect();
                            let tail: Vec<u8> = ring.iter().copied().collect();
                            sessions
                                .lock()
                                .unwrap()
                                .insert(it.id, SessionState { info: it.clone(), ring });
                            send_relay(
                                &relay_tx,
                                Message::text(
                                    json!({
                                        "t": "attached",
                                        "id": it.id,
                                        "scrollback": B64.encode(&tail),
                                        "cols": it.cols,
                                        "rows": it.rows,
                                        "alive": true,
                                    })
                                    .to_string(),
                                ),
                            );
                            changed = true;
                            eprintln!("[agent] mirrored session {} ({}x{})", it.id, it.cols, it.rows);
                        }
                        Err(e) => eprintln!("[agent] attach {} failed: {e}", it.id),
                    }
                }

                let gone: Vec<Uuid> = sessions
                    .lock()
                    .unwrap()
                    .keys()
                    .copied()
                    .filter(|id| !live.contains(id))
                    .collect();
                if !gone.is_empty() {
                    let mut map = sessions.lock().unwrap();
                    for id in gone {
                        map.remove(&id);
                    }
                    changed = true;
                }

                if changed {
                    send_relay(&relay_tx, sessions_frame(&sessions));
                }
            }
        });
    }

    // Relay connect loop (outbound WSS, reconnect with backoff).
    let mut backoff = 1u64;
    loop {
        let req = match cfg.relay_url.as_str().into_client_request() {
            Ok(mut r) => {
                match format!("Bearer {}", cfg.token).parse() {
                    Ok(h) => {
                        r.headers_mut().insert("Authorization", h);
                        r
                    }
                    Err(_) => {
                        eprintln!("[agent] invalid token header");
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("[agent] bad relay url: {e}");
                std::process::exit(1);
            }
        };

        match connect_async(req).await {
            Ok((ws, _resp)) => {
                backoff = 1;
                eprintln!("[agent] relay connected");
                let (mut sink, mut stream) = ws.split();
                let (tx, mut rx) = mpsc::channel::<Message>(1024);
                *relay_tx.lock().unwrap() = Some(tx);

                // Initial snapshot to the relay (it caches/forwards to browsers).
                send_relay(
                    &relay_tx,
                    Message::text(
                        json!({ "t": "host", "status": "online", "name": cfg.name }).to_string(),
                    ),
                );
                send_relay(&relay_tx, sessions_frame(&sessions));
                for m in attached_frames(&sessions) {
                    send_relay(&relay_tx, m);
                }

                let writer = tokio::spawn(async move {
                    while let Some(m) = rx.recv().await {
                        if sink.send(m).await.is_err() {
                            break;
                        }
                    }
                });

                let daemon2 = daemon.clone();
                let sessions2 = sessions.clone();
                let relay_tx2 = relay_tx.clone();
                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(Message::Text(t)) => {
                            handle_browser_frame(t.as_str(), &daemon2, &sessions2, &relay_tx2).await;
                        }
                        Ok(Message::Ping(p)) => send_relay(&relay_tx2, Message::Pong(p)),
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("[agent] relay read error: {e}");
                            break;
                        }
                    }
                }

                *relay_tx.lock().unwrap() = None;
                writer.abort();
                eprintln!("[agent] relay disconnected");
            }
            Err(e) => eprintln!("[agent] relay connect failed: {e}"),
        }

        sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}
