import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthManager, Vault } from "../src/auth.js";
import { createDatabase } from "../src/database.js";
import { createHttpServer } from "../src/http-server.js";
import { RealtimeHub } from "../src/realtime.js";

test("HTTP API authenticates, persists profiles, timers, and encrypted Discord setup", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-http-"));
  const config = {
    repoRoot: path.resolve("."),
    dataDir,
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://127.0.0.1",
    dashboardToken: "integration-dashboard-token-0123456789",
    appSecret: "b".repeat(64),
    eventWebhookToken: "event-token",
    tlsCertFile: null,
    tlsKeyFile: null,
    serviceEditEnabled: true,
    discord: {
      token: null,
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      guildId: null,
      adminRoleIds: [],
      ownerUserIds: [],
    },
  };
  const db = await createDatabase({ dataDir });
  const hub = new RealtimeHub();
  const auth = new AuthManager(config);
  const vault = new Vault(config.appSecret);
  let discordRestarts = 0;
  const discord = {
    status: () => ({
      configured: Boolean(config.discord.token),
      connected: false,
    }),
    start: async () => {},
    stop: async () => {},
    reloadSettings: async () => {},
    restart: async () => {
      discordRestarts += 1;
    },
    refreshStatusPanel: async () => null,
  };
  const services = {
    list: async () => [],
    save: async (value) => value,
    action: async () => ({ state: "stopped" }),
  };
  const backups = {
    status: () => ({ running: false, backups: [] }),
    run: async () => ({ ok: true }),
    test: async () => ({ ok: true, mode: "local" }),
  };
  const spotify = {
    status: () => ({ configured: false, connected: false }),
    authorizationUrl: () => null,
  };
  const server = createHttpServer({
    config,
    auth,
    vault,
    db,
    services,
    backups,
    spotify,
    discord,
    hub,
    getStatus: async () => ({ ok: true, discord: discord.status() }),
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    hub.close();
    await db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const dashboard = await fetch(`${base}/`);
  assert.equal(dashboard.headers.get("cache-control"), "no-store");
  assert.match(await dashboard.text(), /\/app\.js\?v=20260728-1/);

  const dashboardScript = await fetch(`${base}/app.js`);
  assert.equal(dashboardScript.headers.get("cache-control"), "no-cache");

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: config.dashboardToken }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const created = await fetch(`${base}/api/profiles/timer`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "Integration timer",
      config: { startingSeconds: 120, secondsPerEvent: 30 },
    }),
  }).then((response) => response.json());
  assert.equal(created.profile.name, "Integration timer");

  const timerResponse = await fetch(`${base}/api/timer/${created.profile.id}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(timerResponse.status, 200);
  const publicTimer = await fetch(
    `${base}/api/public/timer/${created.profile.id}`,
  ).then((response) => response.json());
  assert.equal(publicTimer.running, true);
  assert.ok(publicTimer.remainingMs <= 120_000 && publicTimer.remainingMs > 115_000);

  const discordSave = await fetch(`${base}/api/settings/discord`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      botToken: "very-secret-discord-token",
      clientSecret: "very-secret-oauth-value",
      clientId: "123456789012345678",
      guildId: "234567890123456789",
      ownerUserIds: ["345678901234567890"],
    }),
  }).then((response) => response.json());
  assert.equal(discordSave.settings.botTokenConfigured, true);
  assert.equal(discordSave.settings.clientSecretConfigured, true);
  assert.equal(discordRestarts, 1);
  assert.equal("botToken" in discordSave.settings, false);
  assert.equal("clientSecret" in discordSave.settings, false);

  const discordSettings = await fetch(`${base}/api/settings/discord`, {
    headers: { cookie },
  }).then((response) => response.json());
  assert.equal(discordSettings.settings.guildId, "234567890123456789");
  assert.equal(discordSettings.settings.botTokenConfigured, true);
  assert.equal(discordSettings.settings.clientSecretConfigured, true);
  assert.equal(discordSettings.status.configured, true);
  assert.equal(JSON.stringify(discordSettings).includes("very-secret-discord-token"), false);
  assert.equal(JSON.stringify(discordSettings).includes("very-secret-oauth-value"), false);

  const encrypted = db.getOauthToken("discord-config");
  assert.ok(encrypted);
  assert.equal(encrypted.includes("very-secret-discord-token"), false);
  assert.equal(vault.decrypt(encrypted).token, "very-secret-discord-token");

  const backupTest = await fetch(`${base}/api/backups/test`, {
    method: "POST",
    headers: { cookie },
  }).then((response) => response.json());
  assert.equal(backupTest.mode, "local");
});
