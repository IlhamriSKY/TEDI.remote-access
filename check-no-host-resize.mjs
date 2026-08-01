#!/usr/bin/env node
// Regression guard: NOTHING may resize a host PTY on behalf of the browser.
//
// The desktop app owns every terminal's size. When the browser could push one,
// dragging the browser window or rotating a phone reshaped the shared PTY, which
// reflowed the matching pane inside TEDI and shredded whatever full-screen CLI
// was running there.
//
// This has regressed TWICE (0.7.4, 0.8.6) because the refusal kept being written
// into the web client, where a stale cached bundle or a leftover localStorage
// flag defeats it. It now lives host-side, in two places (the relay broadcasts
// every browser frame to BOTH the native agent and the SSH bridge, so one of them
// alone is not enough). That is easy to half-undo while "fixing" something else,
// hence this check: it fails the build the moment a resize path comes back.
//
// Run: `node check-no-host-resize.mjs` (also part of `npm run check` and CI).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// [file, forbidden pattern, what re-adding it would break]
const RULES = [
  ["src/index.js", /ssh_resize/, "the SSH bridge would resize the desktop's SSH PTY"],
  ["manifest.json", /ssh_resize/, "re-granting the permission invites the call back"],
  ["sidecar-src/src/main.rs", /"resize"\s*=>/, "the native agent would honour browser resize frames"],
  ["sidecar-src/src/daemon.rs", /fn\s+resize\b/, "the agent could speak resize to the PTY daemon"],
  ["sidecar-src/src/wire.rs", /^\s*Resize\s*\{/m, "the resize frame would be constructible again"],
];

let failed = 0;
const fail = (what, why) => {
  console.error(`  FAIL: ${what}\n        ${why}`);
  failed++;
};

for (const [file, pattern, why] of RULES) {
  const src = readFileSync(join(HERE, file), "utf8");
  if (pattern.test(src)) fail(`${file} matches ${pattern}`, why);
  else console.log(`  ok: ${file} has no host-resize path`);
}

// The client must not SEND a size either. Matched narrowly so the legitimate
// `window.addEventListener("resize", ...)` (which only re-scales the local view)
// is not flagged.
const SEND_RESIZE = /t\s*:\s*"resize"/;
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

let clientHits = 0;
for (const p of walk(join(HERE, "client", "src"))) {
  if (SEND_RESIZE.test(readFileSync(p, "utf8"))) {
    fail(`${p} sends {t:"resize"}`, "the browser would ask the host to reshape a live PTY");
    clientHits++;
  }
}
if (clientHits === 0) console.log("  ok: the web client never sends a resize frame");

if (failed > 0) throw new Error(`check-no-host-resize: ${failed} violation(s)`);
console.log("\ncheck-no-host-resize: the browser cannot resize the desktop.");
