#!/usr/bin/env node
// Proves against a fake host that remote_access never hands back a credential and that disconnect sticks.
import assert from "node:assert/strict";

const SECRET = "tok-SECRET";
let handler = null;
let declared = null;
let onSetting = null;
let spawned = 0;
const killed = [];

globalThis.fetch = async () => ({ ok: true, json: async () => ({ ticket: "ticket-SECRET" }) });
globalThis.WebSocket = class {
  readyState = 1;
  send() {}
  close() {}
};

const ctx = {
  os: { platform: "windows", arch: "x86_64" },
  installPath: "C:/fake",
  secrets: { get: async () => SECRET },
  settings: {
    get: async (key) => (key === "relayUrl" ? `user:pw@relay.example.com/x?token=${SECRET}` : "host"),
    onChange: (_key, fn) => (onSetting = fn),
  },
  statusBar: { setItem() {} },
  ui: { toast() {} },
  logger: { info() {}, warn() {} },
  contribute: { aiTools: (items) => (declared = items) },
  registerAiToolHandler: (_name, fn) => (handler = fn),
  invoke: async (command, args) => {
    if (command === "shell_bg_list") return [];
    if (command === "shell_bg_spawn_direct") return (spawned += 1);
    if (command === "shell_bg_logs") return { bytes: "READY {}\n", next_offset: 1 };
    if (command === "shell_bg_kill") return killed.push(args.handle);
    return [];
  },
};

const { activate, deactivate } = await import("./src/index.js");
await activate(ctx);
await new Promise((resolve) => setTimeout(resolve, 50));

const on = await handler({ action: "status" });
assert.deepEqual(Object.keys(on), ["connected", "agentRunning", "relayHost", "viewers", "message"]);
assert.equal(on.connected, true);
assert.equal(on.relayHost, "relay.example.com");
assert.equal(on.viewers, 0);
assert.doesNotMatch(JSON.stringify(on), /SECRET|user:pw|token|ticket/);

const off = await handler({ action: "disconnect" });
assert.equal(off.disconnected, true);
assert.equal(off.connected, false);
assert.equal(off.agentRunning, false);
assert.deepEqual(killed, [1]);
assert.doesNotMatch(JSON.stringify(off), /SECRET|user:pw|ticket/);

// A settings change queues a restart; the disconnect has to outlive it.
onSetting();
await new Promise((resolve) => setTimeout(resolve, 400));
assert.equal(spawned, 1);

assert.ok((await handler({ action: "start" })).error, "no way to turn it on");
assert.deepEqual(declared[0].parameters.properties.action.enum, ["status", "disconnect"]);
await deactivate();
console.log("[check-ai-tool] ok,", JSON.stringify(declared[0]).length, "chars");
