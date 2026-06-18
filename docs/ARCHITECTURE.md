# TEDI Remote Access - Spesifikasi Teknis

Status: BUILT & DEPLOYED v0.1 (2026-06-18). MVP live at https://remote.ilhamriski.com; full internet e2e PASS. Operator guide: remote-access/README.md.
Target: ekstensi `tedi.remote-access` + agent sidecar (Rust) + relay self-host di VPS milik user.
Penulis acuan: hasil survey arsitektur TEDI (extension host, PTY daemon, sidecar mechanism) per repo `v0.3.42`.

## 1. Tujuan & batasan

**Tujuan.** Membuka terminal yang **sedang aktif di TEDI** (mirror panel, bukan sesi baru) dari **browser device mana pun lewat internet**, selama PC nyala dan TEDI terbuka.

**Keputusan yang sudah diambil bersama user:**

| Keputusan | Pilihan |
| --- | --- |
| Transport internet | **Relay self-host di VPS user** (sudah punya domain + SSL). Tanpa Cloudflare Tunnel / ngrok. |
| Mode sesi | **Mirror panel yang sedang terbuka** (lihat & ketik di terminal yang persis sedang dipakai). |
| Engine | **Agent sidecar native (Rust)**, bukan jembatan murni JS di webview (alasan: stabilitas saat window di-minimize). |
| Jangkauan | Internet, dari browser device asing tanpa instal apa pun di sisi remote. |
| Server (KONFIRMASI) | **VPS dengan nginx** (akses SSH, bisa systemd + proxy WebSocket). Bukan shared hosting. |
| Relay stack | **Node.js 20+** (`ws` + `express`) - satu bahasa dengan browser client, mudah diiterasi. Alternatif: Go (1 binary). |
| Device akses (KONFIRMASI) | **Android + PC**, dua-duanya lewat browser. Butuh UI responsif + dukungan keyboard mobile (lihat s.6). |

**Batasan keras yang sudah dikonfirmasi di kode:**

- Ekstensi TEDI: total <= 50 MiB, per file <= 10 MiB (`install.rs`). Binary agent (~5 MB) muat; relay & cloudflared TIDAK dibundel.
- Extension JS jalan **unsandboxed** di webview utama; gate `ctx.invoke` hanya cek deklarasi permission (`host.ts:437`). Trust model = consent saat install.
- PTY daemon socket **lokal-only** (named pipe Windows / unix socket), ACL per-user. Agent harus proses **co-located** (jalan di mesin yang sama).
- Core TEDI **tidak punya inbound listener**. CSP `null` (webview bebas koneksi keluar). Semua exposure adalah kode baru.

## 2. Arsitektur tingkat tinggi

```
  Browser device asing                      VPS user (domain + SSL)                 PC user (TEDI terbuka)
 ┌───────────────────┐    wss (TLS)     ┌──────────────────────────┐   wss (TLS)  ┌─────────────────────────┐
 │ xterm.js web UI   │ ───────────────► │  nginx/caddy (SSL term)  │ ◄─────────── │  Agent sidecar (Rust)   │
 │  - login          │                  │      │ reverse proxy      │   OUTBOUND   │   - 1 koneksi keluar    │
 │  - daftar panel   │ ◄─────────────── │      ▼                    │              │   - multiplex N panel   │
 │  - terminal hidup │     frames       │  Relay (Node/Go)         │              │            │            │
 └───────────────────┘                  │   - auth browser (login) │              │            ▼            │
                                        │   - auth agent (token)   │              │  named pipe (lokal)     │
                                        │   - pasangkan & pipe     │              │            │            │
                                        └──────────────────────────┘              │            ▼            │
                                                                                  │  PTY Daemon TEDI        │
                                                                                  │  (Attach/Data/Write)    │
                                                                                  └─────────────────────────┘
```

Tiga komponen baru:

1. **Agent sidecar** (Rust, dibundel di ekstensi) - di-spawn ekstensi saat TEDI terbuka. Konek ke PTY daemon (mirror) + buka WSS keluar ke relay.
2. **Relay** (Node.js atau Go, di VPS) - di belakang nginx/caddy yang sudah punya SSL. Mempasangkan agent <-> browser, menjaga auth.
3. **Browser client** (HTML + xterm.js, statis) - disajikan relay/nginx. Login, lihat daftar panel, render terminal.

Plus **shell ekstensi tipis** (`extension.js`) yang cuma men-spawn agent + UI status, tidak menyentuh data terminal (itu tugas agent native).

## 3. Kenapa desain ini (justifikasi)

- **Mirror via agent->daemon pipe, bukan webview.** Daemon TEDI sudah multi-subscriber (`protocol.rs`: `Data`/`Exit` di-fan-out ke semua client, maks 64). Agent yang konek sebagai **client terpisah** menjadi subscriber tambahan yang bersih, tanpa mengganggu pane GUI. Kalau lewat webview (`pty_attach` kedua di proses yang sama), berisiko membajak channel attach milik GUI -> pane lokal bisa berhenti menerima output.
- **Native agent untuk stabilitas.** Webview di-throttle OS saat window minimize/background (kondisi normal remote access). Proses native tidak kena throttle, selamat dari reload webview, dan menangani buffering/backpressure/reconnect lebih andal. (Catatan: daemon membuang `Data` saat backpressure di sisi writer, jadi konsumen harus gesit -> Rust > JS.)
- **Relay outbound = tembus NAT gratis.** Agent dial keluar ke VPS user; tidak ada port inbound di PC. Kebal NAT, CGNAT, IP dinamis. Pakai SSL yang sudah dimiliki user.
- **Tanpa ubah core TEDI.** Agent bicara ke daemon lewat named pipe yang sudah ada + extension memakai command `shell_bg_*` yang sudah ada. Fitur ini bisa rilis sebagai ekstensi installable, tanpa release TEDI baru. (User adalah pemilik TEDI, jadi boleh berbagi `protocol.rs` ke crate agent.)

## 4. Komponen 1: Agent sidecar (Rust)

**Lokasi paket:** `extensions/tedi.remote-access/sidecar/windows-x86_64/tedi-remote-agent.exe` (ikut layout `platformDir()` SQL Explorer). User hanya butuh Windows x86_64, jadi satu target.

**Dependensi inti:** `tokio`, `tokio-tungstenite` + `rustls` (WSS keluar), `interprocess` (pipe daemon, sama seperti TEDI), `serde`/`serde_json`, `base64`, `uuid`. Pakai `[profile.release] opt-level="z", lto="thin", strip` agar <= 10 MiB.

### 4.1 Boot & handshake (identik pola SQL Explorer)

1. Ekstensi spawn: `ctx.invoke("shell_bg_spawn_direct", { program, args: ["--relay", relayUrl] })`.
2. Agent cetak `READY {"pid":..,"version":..}` ke stdout, di-flush. (Tidak perlu port lokal karena agent yang dial keluar; READY hanya tanda hidup yang dibaca via `shell_bg_logs`.)
3. Token & konfigurasi sensitif (agent token relay) dikirim via env atau file config di `installPath`, BUKAN argumen CLI (argumen kelihatan di process list).

### 4.2 Koneksi ke PTY daemon (mirror engine)

Agent berbicara protokol daemon yang sudah ada (`pty_daemon/protocol.rs`), length-prefixed JSON (lihat `transport.rs`):

```
Windows pipe name : \\.\pipe\tedi-ptyd-<fnv1a(USERNAME) 8-hex>   // paths.rs:50
Unix socket       : $XDG_RUNTIME_DIR/tedi-ptyd.sock (fallback $TMPDIR/tedi-ptyd-<USER>.sock)
```

Alur:

1. `Hello { req_id, version: 1 }` -> tunggu `Welcome`. Kalau `version` mismatch -> agent log error + retry/menyerah (lihat Risiko di s.10).
2. `List { req_id }` -> `Sessions { items: [SessionInfo{ id, cwd, cols, rows, alive, created_at_ms }] }`.
3. Untuk tiap sesi `alive`: `Attach { req_id, session_id, cols, rows }` -> `AttachOk { scrollback_b64, alive }`. Simpan `scrollback_b64` untuk dikirim ke browser yang baru connect.
4. Sesudah attach, agent menerima push `Data { session_id, data_b64 }` dan `Exit { session_id, code }` untuk SEMUA sesi yang di-attach (fan-out).
5. **Polling penemuan panel:** daemon tidak push "sesi baru". Agent `List` tiap ~2 dtk untuk mendeteksi panel baru (attach) & panel hilang (lupakan). `Exit` menandai shell mati.

**Input balik:** frame `input` dari browser -> agent kirim `Write { session_id, data_b64 }` ke daemon. Karena ini PTY yang sama, ketikan muncul juga di pane lokal (itulah arti "mirror").

**Resize (MVP = size-follow, hindari perang ukuran):** remote me-render xterm pada `cols/rows` milik PTY (dari `SessionInfo`), dan **tidak** mengirim `Resize`. Kalau remote mengubah ukuran lokal via `Resize`, PTY ikut berubah dan pane lokal ikut reflow. "Take control / ubah ukuran dari remote" ditunda ke v2 (butuh kebijakan siapa pemilik ukuran).

### 4.3 Koneksi ke relay (transport keluar)

- Buka `wss://<domain>/tedi/agent` dengan header `Authorization: Bearer <AGENT_TOKEN>`.
- Multiplex semua sesi pada satu WSS (frame membawa `id` = uuid sesi).
- **Heartbeat:** kirim ping tiap ~25 dtk (lewatkan idle-timeout proxy).
- **Reconnect:** backoff eksponensial (mis. 1s,2s,4s..maks 30s) selama TEDI hidup. Saat reconnect, kirim ulang snapshot `sessions` + scrollback terakhir.
- **Backpressure ke remote lambat:** buffer per-sesi dibatasi (mis. 256 KiB) ; kalau penuh, jatuhkan ke "perlu refresh" (kirim ulang scrollback) daripada OOM.

## 5. Komponen 2: Relay (VPS)

**Bahasa:** Node.js (`ws` + `express`) atau Go (`nhooyr/websocket`). PHP tidak cocok untuk WS long-lived. Jalan sebagai service (systemd/pm2), nginx/caddy yang sudah ada mem-proxy `/tedi/` ke port lokal relay dan menterminasi TLS.

**Endpoint:**

| Endpoint | Sisi | Auth |
| --- | --- | --- |
| `GET /tedi/` | Browser | Halaman login + (setelah login) UI xterm |
| `POST /tedi/login` | Browser | username + password (hash argon2/bcrypt) -> set cookie sesi (httpOnly, Secure, SameSite=Strict, exp pendek) + idealnya TOTP |
| `wss://.../tedi/client` | Browser | Cookie sesi valid |
| `wss://.../tedi/agent` | Agent PC | `Bearer <AGENT_TOKEN>` (random 32B, di keychain TEDI + env relay) |

**Tugas relay (sengaja "bodoh"):** ia TIDAK mengerti isi terminal. Ia hanya:
1. Terima 1 koneksi agent terautentikasi (MVP: single-PC/single-account).
2. Terima koneksi browser terautentikasi.
3. Teruskan frame opaque browser<->agent. Saat browser connect, minta agent kirim snapshot `sessions` + scrollback.
4. Saat agent putus, beri tahu browser "host offline".

**nginx (contoh location, WSS upgrade):**

```nginx
location /tedi/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # WS long-lived
}
```

## 6. Komponen 3: Browser client

- Statis: `index.html` + xterm.js (+ addon-fit, addon-webgl) + sedikit JS.
- Alur: login -> WSS `/tedi/client` -> terima `sessions` -> render daftar panel -> buka tiap panel sebagai tab xterm -> tulis `scrollback` -> stream `data` live.
- Input keyboard -> frame `input`. Resize lokal browser (MVP): xterm di-fit ke kontainer untuk tampilan, tapi **tidak** mengubah ukuran PTY host (size-follow host). Bila perlu, tampilkan ukuran host dan "scale to fit".
- Reconnect otomatis dengan minta ulang `sessions` + scrollback.

**Catatan Android / mobile (penting untuk usability):**
- **Keyboard virtual.** xterm.js tidak otomatis memunculkan soft-keyboard di mobile. Solusi: sebuah `<textarea>`/contenteditable tersembunyi yang di-`focus()` saat terminal di-tap; inputnya diteruskan jadi frame `input`. Tanpa ini, di HP tidak bisa mengetik.
- **Toolbar tombol khusus.** Keyboard HP tidak punya Esc, Tab, Ctrl, panah, `|`, `/`, `~`. Sediakan baris tombol bantu di atas/bawah terminal (Esc, Tab, Ctrl-modifier sticky, arrow keys, common symbols).
- **Layout responsif.** Di HP: daftar panel jadi drawer/collapsible, terminal full-screen. Di PC: split sidebar + terminal.
- **Font & scale.** Kontrol ukuran font + opsi "scale to fit" karena lebar PTY host (size-follow) bisa lebih besar dari layar HP.
- **Lifecycle tab.** Browser mobile membekukan tab di background -> WSS bisa putus. Andalkan auto-reconnect + replay scrollback saat tab kembali aktif.

## 7. Protokol kawat agent <-> relay <-> browser (BARU)

Relay meneruskan apa adanya, jadi ini protokol logis **agent <-> browser**. JSON teks; byte terminal di-base64.

**Agent -> Browser:**

```jsonc
{ "t": "sessions", "items": [ { "id":"<uuid>", "cwd":"...", "cols":80, "rows":24, "alive":true, "title":"pwsh" } ] }
{ "t": "attached", "id":"<uuid>", "scrollback":"<b64>", "cols":80, "rows":24, "alive":true }
{ "t": "data", "id":"<uuid>", "b64":"<bytes>" }
{ "t": "exit", "id":"<uuid>", "code":0 }
{ "t": "host", "status":"online|offline" }
{ "t": "pong" }
```

**Browser -> Agent:**

```jsonc
{ "t": "hello", "client":"web/1.0" }
{ "t": "subscribe",   "id":"<uuid>" }     // opsional; MVP boleh auto-subscribe semua
{ "t": "unsubscribe", "id":"<uuid>" }
{ "t": "input",  "id":"<uuid>", "b64":"<bytes>" }   // -> daemon Write(uuid, b64)
{ "t": "resize", "id":"<uuid>", "cols":120, "rows":30 } // v2; MVP diabaikan (size-follow)
{ "t": "ping" }
```

**Agent <-> Daemon (sudah ada, jangan diubah):** `Hello/Welcome`, `List/Sessions`, `Attach/AttachOk`, `Write`, `Resize`, `Detach`, push `Data`/`Exit`. Disarankan **berbagi `pty_daemon/protocol.rs`** ke crate agent agar definisi tidak menyimpang.

## 8. Desain keamanan (berlapis - ini shell penuh ke internet)

Urutan pertahanan:

1. **TLS wajib** (sertifikat existing user via nginx/caddy). `wss://` saja, tolak `ws://`.
2. **Auth agent** (`Bearer AGENT_TOKEN`, random >=32B) disimpan di **keychain TEDI** via `ctx.secrets` (namespaced `tedi-ext:tedi.remote-access`), dicocokkan konstan-time di relay. Tidak pernah ke disk plaintext / argumen CLI.
3. **Auth browser**: login password (hash argon2id) + **TOTP** sangat disarankan. Cookie sesi httpOnly+Secure+SameSite=Strict, exp pendek (mis. 12 jam), bisa dicabut.
4. **Rate-limit + lockout** login di relay (mis. 5 gagal -> jeda eksponensial). Log IP.
5. **Tidak ada port host yang terbuka**: agent hanya dial keluar; relay satu-satunya yang publik dan ia di belakang auth.
6. **Defense in depth aplikasi (opsional MVP+):** mode **read-only** (abaikan `input`), **idle timeout** sesi remote, **allowlist sesi** yang diekspos, dan **audit log** ketikan remote di agent.
7. **Catatan eksposur inheren:** named pipe daemon ber-ACL per-user; proses apa pun milik user itu bisa attach. Agent tidak menambah eksposur baru di mesin, tapi relay membuka jalur internet, maka kekuatan auth = garis pertahanan utama.

**Pesan jujur untuk user:** ini benar-benar memberi shell penuh mesinmu lewat internet. Wajib: TLS + password kuat + TOTP + rate-limit. Tanpa TOTP, pertimbangkan IP allowlist di nginx.

## 9. Ekstensi: manifest, permission, lifecycle, packaging

**`manifest.json` (permission minimal):**

```jsonc
{
  "id": "tedi.remote-access",
  "name": "Remote Access",
  "version": "0.1.0",
  "main": "extension.js",
  "permissions": [
    "invoke:shell_bg_spawn_direct",  // spawn agent
    "invoke:shell_bg_logs",          // baca READY
    "invoke:shell_bg_kill",          // stop agent
    "secrets:read", "secrets:write", // AGENT_TOKEN
    "settings:read", "settings:write", // relay URL, enable, opsi
    "ui:toast",
    "statusbar:write"                // indikator on/off + jumlah client
  ],
  "contributes": {
    "commands": [{ "id": "tedi.remote-access.toggle", "title": "Toggle Remote Access", "category": "Remote" }],
    "keybindings": [{ "command": "tedi.remote-access.toggle", "key": "Mod+Alt+R" }]
  },
  "engines": { "tedi": ">=0.3.42" }
}
```

Catatan: **tidak butuh `invoke:pty_*`** karena akses PTY terjadi di agent native lewat pipe daemon, bukan via `ctx.invoke`. Permukaan permission jadi kecil (gate `host.ts:437` tetap lega untuk `shell_bg_*` - di dialog install ditandai HIGH risk, user harus sadar menyetujui).

**Lifecycle:**
- `activate(ctx)` -> baca config (relay URL, token, enabled). Kalau enabled -> `ensureAgent()` (spawn + tunggu READY).
- Status bar menampilkan: Off / Connecting / Online (n client).
- TEDI ditutup -> Job Object kill-on-close mematikan agent -> relay tandai host offline -> browser lihat "offline". Sesuai syarat "PC nyala + TEDI terbuka".
- `deactivate()` -> `shell_bg_kill` agent.

**Packaging (zip ekstensi):** `manifest.json`, `extension.js`, `sidecar/windows-x86_64/tedi-remote-agent.exe`. Relay + client web **di-deploy terpisah** ke VPS (di luar zip).

## 10. Risiko & spike validasi (lakukan SEBELUM koding penuh)

1. **[RESOLVED ✅] Multi-subscriber per sesi.** Dibuktikan oleh `remote-access/spike-daemon-attach` pada 2026-06-18 melawan daemon hidup `0.3.42`: proses terpisah connect sebagai client ke-2, `Hello`→`Welcome`, `List`→1 sesi, `Attach`→**902 KB scrollback** + Data live. Pipe name `tedi-ptyd-92db931e` cocok dengan `fnv1a("IT STAFF")`. GUI (yang kebetulan menjalankan Claude Code) tetap render normal selama attach -> **tidak terbajak**. Path 2 (agent native sebagai client daemon terpisah) VALID. Catatan: sesi yang di-mirror bisa berupa TUI full-screen (alt-screen + ANSI); xterm di browser merekonstruksi dari replay byte mentah, jadi ini sudah ditangani by design.
2. **Nama pipe dev vs prod.** `socket_name()` hanya pakai USERNAME (tidak ada bundle id di kode yang dibaca), tapi TEDI.md menyebut split `cfg(debug_assertions)`. Konfirmasi nama pipe pada build rilis yang dipakai user.
3. **Versi protokol daemon.** `PROTOCOL_VERSION=1`. Karena user pemilik TEDI, jaga agar agent & TEDI sinkron; agent harus gagal anggun saat mismatch.
4. **Resize war.** Pastikan kebijakan size-follow benar (remote tidak mengubah ukuran host) sebelum mengaktifkan resize remote.
5. **Idle WS timeout** di nginx/relay vs heartbeat 25s.

## 11. Ruang lingkup MVP vs v2

**MVP (target pertama):**
- Mirror semua sesi `alive`, read+write, size-follow host.
- Relay single-account single-PC, login password + cookie. (TOTP segera menyusul.)
- Reconnect agent & browser, scrollback replay.
- Status bar + toggle.

**v2+:**
- Resize "take control", multi-PC per akun, file browser via `fs_*`, editor mirror via `ctx.editor`, TOTP wajib, audit log UI, mode read-only, multi-user.

## 12. Rencana kerja (saat mulai bangun)

1. Spike #1 (multi-subscriber) - bukti konsep agent<->daemon.
2. Crate agent: daemon client + WSS client + multiplex + reconnect.
3. Relay Node/Go + nginx config + auth.
4. Browser client (xterm.js).
5. Shell ekstensi (spawn agent, status bar, config).
6. Uji end-to-end dari HP lewat 4G (jaringan benar-benar eksternal).
7. Hardening keamanan (TOTP, rate-limit, audit).

---

Acuan file kunci di repo: `src-tauri/src/modules/pty_daemon/protocol.rs`, `.../paths.rs`, `src-tauri/src/modules/pty/mod.rs`, `src-tauri/src/modules/shell/` (`shell_bg_spawn_direct`), `src/modules/extensions/host.ts`, `extensions/tedi.sql-explorer/src/sidecar.js` (pola spawn + READY).
