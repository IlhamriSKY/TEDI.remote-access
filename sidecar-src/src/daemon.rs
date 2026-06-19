//! Daemon client. Connects to TEDI's PTY daemon as an INDEPENDENT second client
//! (the GUI is the first) over the same per-user endpoint TEDI binds: a
//! kernel-namespaced pipe on Windows, a filesystem socket on Unix. Speaks the
//! length-prefixed JSON protocol, correlates request/response by `req_id` via
//! a reader thread, and forwards push `Data`/`Exit` events into an async
//! channel. Validated by the daemon multi-subscriber spike.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use interprocess::local_socket::traits::Stream as _StreamTrait;
use interprocess::local_socket::Stream;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

use crate::wire::{ClientMsg, DaemonMsg, SessionInfo, PROTOCOL_VERSION};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Push events fanned out of the daemon for a session we have attached to.
pub enum DaemonEvent {
    Data { id: Uuid, b64: String },
    Exit { id: Uuid, code: i32 },
}

pub struct DaemonClient {
    stream: Arc<Stream>,
    write_lock: Mutex<()>,
    next_req: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<DaemonMsg>>>,
}

fn write_msg(stream: &Stream, msg: &ClientMsg) -> io::Result<()> {
    let body = serde_json::to_vec(msg).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut s = stream;
    s.write_all(&(body.len() as u32).to_be_bytes())?;
    s.write_all(&body)?;
    s.flush()
}

/// Cap on a single daemon frame (matches the relay's WS payload cap) so a
/// malformed or hostile 4-byte length prefix can't trigger a multi-GiB
/// allocation in the reader thread.
const MAX_FRAME: usize = 16 * 1024 * 1024;

fn read_msg(stream: &Stream) -> io::Result<DaemonMsg> {
    let mut s = stream;
    let mut prefix = [0u8; 4];
    s.read_exact(&mut prefix)?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "daemon frame too large"));
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

impl DaemonClient {
    /// Connect + handshake synchronously, then spawn the reader thread.
    pub fn connect(
        pipe_name: &str,
        events: UnboundedSender<DaemonEvent>,
    ) -> Result<Arc<Self>, String> {
        // `pipe_name` is a namespaced name on Windows, a filesystem path on Unix
        // (see `default_socket()` in main.rs); connect the matching way.
        #[cfg(windows)]
        let stream = {
            use interprocess::local_socket::{GenericNamespaced, ToNsName};
            let name = pipe_name
                .to_ns_name::<GenericNamespaced>()
                .map_err(|e| format!("pipe name: {e}"))?;
            Stream::connect(name).map_err(|e| format!("connect daemon pipe: {e}"))?
        };
        #[cfg(unix)]
        let stream = {
            use interprocess::local_socket::{GenericFilePath, ToFsName};
            let name = pipe_name
                .to_fs_name::<GenericFilePath>()
                .map_err(|e| format!("socket path: {e}"))?;
            Stream::connect(name).map_err(|e| format!("connect daemon socket: {e}"))?
        };
        let stream = Arc::new(stream);

        write_msg(
            stream.as_ref(),
            &ClientMsg::Hello { req_id: 0, version: PROTOCOL_VERSION },
        )
        .map_err(|e| format!("daemon hello write: {e}"))?;
        match read_msg(stream.as_ref()).map_err(|e| format!("daemon hello read: {e}"))? {
            DaemonMsg::Welcome { version, daemon_version, .. } => {
                eprintln!("[agent] daemon welcome: proto v{version} ({daemon_version})");
                if version != PROTOCOL_VERSION {
                    eprintln!(
                        "[agent] WARN: daemon proto v{version} != agent v{PROTOCOL_VERSION}; \
                         mirror may misbehave. Rebuild the agent against this TEDI."
                    );
                }
            }
            other => return Err(format!("unexpected handshake reply: {other:?}")),
        }

        let client = Arc::new(Self {
            stream,
            write_lock: Mutex::new(()),
            next_req: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        });
        let reader = client.clone();
        thread::Builder::new()
            .name("daemon-reader".into())
            .spawn(move || reader.reader_loop(events))
            .map_err(|e| format!("spawn daemon reader: {e}"))?;
        Ok(client)
    }

    fn reader_loop(self: Arc<Self>, events: UnboundedSender<DaemonEvent>) {
        loop {
            match read_msg(self.stream.as_ref()) {
                Ok(DaemonMsg::Data { session_id, data_b64 }) => {
                    let _ = events.send(DaemonEvent::Data { id: session_id, b64: data_b64 });
                }
                Ok(DaemonMsg::Exit { session_id, code }) => {
                    let _ = events.send(DaemonEvent::Exit { id: session_id, code });
                }
                Ok(other) => {
                    if let Some(rid) = other.req_id() {
                        if let Some(tx) = self.pending.lock().unwrap().remove(&rid) {
                            let _ = tx.send(other);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[agent] daemon connection ended: {e}");
                    break;
                }
            }
        }
        // The daemon vanished (TEDI closed, or daemon crash). Exit non-zero so
        // the extension's supervisor respawns us when appropriate.
        std::process::exit(3);
    }

    fn next(&self) -> u64 {
        self.next_req.fetch_add(1, Ordering::Relaxed)
    }

    async fn request(&self, build: impl FnOnce(u64) -> ClientMsg) -> Result<DaemonMsg, String> {
        let rid = self.next();
        let msg = build(rid);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(rid, tx);
        {
            let _guard = self.write_lock.lock().unwrap();
            if let Err(e) = write_msg(self.stream.as_ref(), &msg) {
                self.pending.lock().unwrap().remove(&rid);
                return Err(format!("daemon write: {e}"));
            }
        }
        match timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => Err("daemon dropped response".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&rid);
                Err("daemon request timed out".into())
            }
        }
    }

    pub async fn list(&self) -> Result<Vec<SessionInfo>, String> {
        match self.request(|rid| ClientMsg::List { req_id: rid }).await? {
            DaemonMsg::Sessions { items, .. } => Ok(items),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("list: unexpected {o:?}")),
        }
    }

    /// Returns (scrollback_b64, alive).
    pub async fn attach(&self, id: Uuid, cols: u16, rows: u16) -> Result<(String, bool), String> {
        match self
            .request(|rid| ClientMsg::Attach { req_id: rid, session_id: id, cols, rows })
            .await?
        {
            DaemonMsg::AttachOk { scrollback_b64, alive, .. } => Ok((scrollback_b64, alive)),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("attach: unexpected {o:?}")),
        }
    }

    /// Open a NEW PTY session in the daemon (the "new tab from the browser"
    /// path). The daemon adds it to its global session map, so the agent's poll
    /// loop discovers it on the next `list()` and mirrors it like any other.
    /// Returns the new session id.
    pub async fn open(&self, cols: u16, rows: u16, cwd: Option<String>) -> Result<Uuid, String> {
        match self
            .request(|rid| ClientMsg::Open { req_id: rid, cols, rows, cwd })
            .await?
        {
            DaemonMsg::OpenOk { session_id, .. } => Ok(session_id),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("open: unexpected {o:?}")),
        }
    }

    /// `data_b64` must be base64 of the raw input bytes (the daemon decodes it
    /// and writes them to the PTY stdin) — same contract as `pty_write`.
    pub async fn write(&self, id: Uuid, data_b64: String) -> Result<(), String> {
        match self
            .request(|rid| ClientMsg::Write { req_id: rid, session_id: id, data_b64 })
            .await?
        {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("write: unexpected {o:?}")),
        }
    }

    /// Permanently kill a session's PTY (the browser "close tab" path). The
    /// daemon removes the session and pushes `Exit` to every subscriber, so the
    /// desktop app's tab closes too. Mirrors TEDI core's `ClientMsg::Close`.
    pub async fn close(&self, id: Uuid) -> Result<(), String> {
        match self
            .request(|rid| ClientMsg::Close { req_id: rid, session_id: id })
            .await?
        {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("close: unexpected {o:?}")),
        }
    }

    /// Resize a session's PTY. No longer called: the browser mirrors at the
    /// host's real size and scales to fit client-side, so it never resizes the
    /// shared PTY (which would reflow the desktop terminal). Kept for protocol
    /// completeness.
    #[allow(dead_code)]
    pub async fn resize(&self, id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
        match self
            .request(|rid| ClientMsg::Resize { req_id: rid, session_id: id, cols, rows })
            .await?
        {
            DaemonMsg::Ok { .. } => Ok(()),
            DaemonMsg::Err { message, .. } => Err(message),
            o => Err(format!("resize: unexpected {o:?}")),
        }
    }
}
