import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager, Vault } from "../src/auth.js";
import { createDatabase } from "../src/database.js";
import { createHttpServer } from "../src/http-server.js";
import { PollManager } from "../src/poll-manager.js";
import { RealtimeHub } from "../src/realtime.js";

class FakeSocket extends EventEmitter {
  static created = 0;
  constructor() {
    super();
    FakeSocket.created += 1;
  }
  send() {}
  close() { this.emit("close"); }
}

test("poll HTTP state is passive and control requires authentication", async (context) => {
  FakeSocket.created = 0;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-poll-http-"));
  const config = {
    repoRoot: path.resolve("."),
    dataDir,
    publicBaseUrl: "http://127.0.0.1",
    dashboardToken: "poll-dashboard-token-0123456789",
    appSecret: "p".repeat(64),
    eventWebhookToken: "event-token",
    tlsCertFile: null,
    tlsKeyFile: null,
    discord: { ownerUserIds: [] },
  };
  const db = await createDatabase({ dataDir });
  const hub = new RealtimeHub();
  const auth = new AuthManager(config);
  const polls = new PollManager({ db, hub, WebSocketImpl: FakeSocket });
  await db.saveOverlay({
    id: "community-choice",
    type: "poll",
    name: "Community choice",
    config: { channel: "example", durationSeconds: 10 },
  });
  const server = createHttpServer({
    config,
    auth,
    vault: new Vault(config.appSecret),
    db,
    polls,
    services: { list: async () => [] },
    backups: { status: () => ({}) },
    spotify: { status: () => ({}) },
    discord: { status: () => ({ connected: false }) },
    hub,
    getStatus: async () => ({ ok: true }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    await polls.stopAll();
    hub.close();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const passive = await fetch(`${base}/api/public/polls/community-choice`);
  assert.equal(passive.status, 200);
  assert.equal((await passive.json()).status, "idle");
  assert.equal(FakeSocket.created, 0);

  const unauthorized = await fetch(`${base}/api/polls/community-choice/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(FakeSocket.created, 0);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: config.dashboardToken }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const started = await fetch(`${base}/api/polls/community-choice/control`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).state.status, "active");
  assert.equal(FakeSocket.created, 1);
});
