//! Wire types.
//!
//! Two protocols meet in the agent:
//!   1. Daemon protocol (verbatim shapes from TEDI's
//!      `src-tauri/src/modules/pty_daemon/protocol.rs`) — length-prefixed
//!      JSON over the local named pipe. Defined here so the agent stays a
//!      standalone crate; keep these in lockstep with TEDI's PROTOCOL_VERSION.
//!   2. Relay protocol (agent <-> browser) — JSON text frames carried
//!      opaquely by the relay. Built ad hoc with
//!      `serde_json::json!` in main.rs, so only the daemon types live here.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Must match TEDI's `pty_daemon::protocol::PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    Hello { req_id: u64, version: u32 },
    Attach { req_id: u64, session_id: Uuid, cols: u16, rows: u16 },
    Detach { req_id: u64, session_id: Uuid },
    Write { req_id: u64, session_id: Uuid, data_b64: String },
    Resize { req_id: u64, session_id: Uuid, cols: u16, rows: u16 },
    List { req_id: u64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DaemonMsg {
    Welcome { req_id: u64, version: u32, daemon_version: String },
    OpenOk { req_id: u64, session_id: Uuid },
    AttachOk { req_id: u64, session_id: Uuid, scrollback_b64: String, alive: bool },
    Ok { req_id: u64 },
    Err { req_id: u64, message: String },
    Sessions { req_id: u64, items: Vec<SessionInfo> },
    Data { session_id: Uuid, data_b64: String },
    Exit { session_id: Uuid, code: i32 },
}

impl DaemonMsg {
    /// Request-correlation id for response variants; `None` for push events.
    pub fn req_id(&self) -> Option<u64> {
        match self {
            DaemonMsg::Welcome { req_id, .. }
            | DaemonMsg::OpenOk { req_id, .. }
            | DaemonMsg::AttachOk { req_id, .. }
            | DaemonMsg::Ok { req_id }
            | DaemonMsg::Err { req_id, .. }
            | DaemonMsg::Sessions { req_id, .. } => Some(*req_id),
            DaemonMsg::Data { .. } | DaemonMsg::Exit { .. } => None,
        }
    }
}
