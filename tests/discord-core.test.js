import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GatewayIntentBits, PermissionFlagsBits } from "discord.js";

import { createDatabase } from "../src/database.js";
import {
  buildVoicePermissionOverwrites,
  createDiscordBot,
  discordConnectionDiagnostic,
  discordGatewayIntents,
  isDiscordAdmin,
  normalizeVoicePreferences,
  sanitizeVoiceChannelName,
} from "../src/discord-bot.js";

async function temporaryDirectory() {
  const root = join(process.cwd(), ".test-data");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "discord-core-"));
}

test("Discord requests the privileged members intent only for automatic roles", () => {
  const basic = discordGatewayIntents({
    discord: { token: "token", autoRoleId: "" },
  });
  assert.equal(basic.includes(GatewayIntentBits.Guilds), true);
  assert.equal(basic.includes(GatewayIntentBits.GuildVoiceStates), true);
  assert.equal(basic.includes(GatewayIntentBits.GuildMembers), false);

  const autoRole = discordGatewayIntents({
    discord: { token: "token", autoRoleId: "role-id" },
  });
  assert.equal(autoRole.includes(GatewayIntentBits.GuildMembers), true);
  assert.equal(
    discordConnectionDiagnostic(
      new Error("Used disallowed intents"),
      { discord: { autoRoleId: "role-id" } },
    ).code,
    "disallowed-intents",
  );
});

test("database persists JSON-backed records across restarts", async (t) => {
  const dataDir = await temporaryDirectory();
  const first = await createDatabase({ dataDir });

  await first.setSetting("overlay.theme", {
    font: "Atkinson Hyperlegible",
    colors: ["#fff", "#111"],
  });
  await first.saveOverlay({
    id: "chat-main",
    type: "twitch-chat",
    name: "Main chat",
    config: { fontSize: 28, showBadges: true },
  });
  await first.saveService({
    id: "podcast-tools",
    name: "Podcast tools",
    command: "/data/data/com.termux/files/usr/bin/node",
    args: ["server.js"],
    cwd: "/data/data/com.termux/files/home/podcast",
    env: { NODE_ENV: "production" },
  });
  await first.saveVoicePreferences({
    guildId: "1234567890",
    userId: "9876543210",
    name: "Podcast room",
    visibility: "private",
    whitelist: ["1111111111", "1111111111", "9876543210"],
    userLimit: 6,
  });
  await first.saveTempChannel({
    channelId: "5555555555",
    guildId: "1234567890",
    ownerUserId: "9876543210",
    lobbyChannelId: "4444444444",
    config: { visibility: "private" },
  });
  await first.saveOauthToken({
    provider: "spotify",
    encryptedToken: "v1:nonce:ciphertext:tag",
    expiresAt: "2030-01-01T00:00:00.000Z",
    scopes: ["user-read-currently-playing"],
  });
  await first.close();

  const file = await readFile(join(dataDir, "streamforge.sqlite"));
  assert.ok(file.byteLength > 1_000);

  const reopened = await createDatabase({ dataDir });
  t.after(async () => {
    await reopened.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.deepEqual(reopened.getSetting("overlay.theme"), {
    font: "Atkinson Hyperlegible",
    colors: ["#fff", "#111"],
  });
  assert.equal(reopened.getOverlay("chat-main").config.fontSize, 28);
  assert.equal(
    reopened.getOverlay("twitch-chat", "chat-main").name,
    "Main chat",
  );
  assert.equal(reopened.getOverlay("alerts", "chat-main"), null);
  assert.deepEqual(reopened.getService("podcast-tools").args, ["server.js"]);
  assert.deepEqual(
    reopened.getVoicePreferences("1234567890", "9876543210"),
    {
      guildId: "1234567890",
      userId: "9876543210",
      name: "Podcast room",
      visibility: "private",
      whitelist: ["1111111111"],
      userLimit: 6,
      updatedAt: reopened.getVoicePreferences(
        "1234567890",
        "9876543210",
      ).updatedAt,
    },
  );
  assert.equal(reopened.getTempChannel("5555555555").ownerUserId, "9876543210");
  assert.equal(
    reopened.getOauthToken("spotify"),
    "v1:nonce:ciphertext:tag",
  );
  assert.equal(
    reopened.getOauthTokenRecord("spotify").expiresAt,
    "2030-01-01T00:00:00.000Z",
  );
  assert.equal(reopened.getSettings().spotify, undefined);
});

test("database serializes concurrent mutations and redacts audit secrets", async (t) => {
  const dataDir = await temporaryDirectory();
  const db = await createDatabase({ dataDir });
  t.after(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      db.setSetting(`concurrent.${index}`, { index }),
    ),
  );
  assert.equal(Object.keys(db.getSettings("concurrent.")).length, 20);

  await db.addAudit({
    action: "oauth.refreshed",
    actorId: "system",
    details: {
      accessToken: "must-not-be-saved",
      nested: { client_secret: "also-private", safe: true },
    },
  });
  const [audit] = db.listAudit();
  assert.equal(audit.details.accessToken, "[REDACTED]");
  assert.equal(audit.details.nested.client_secret, "[REDACTED]");
  assert.equal(audit.details.nested.safe, true);
  await db.addAudit("dashboard-user", "settings.saved", "discord");
  assert.equal(
    db.listAudit({ action: "settings.saved" })[0].actorId,
    "dashboard-user",
  );

  await db.saveOauthToken("spotify", "v1.legacy-compatible");
  assert.equal(db.getOauthToken("spotify"), "v1.legacy-compatible");

  assert.throws(
    () => db.setSetting("broken", 1n),
    /JSON serializable/,
  );
});

test("voice preferences are bounded and permission modes are explicit", () => {
  assert.equal(
    sanitizeVoiceChannelName("\u0000   My    Podcast   "),
    "My Podcast",
  );
  const preferences = normalizeVoicePreferences(
    {
      name: "",
      visibility: "private",
      whitelist: ["123456", "123456", "not-an-id"],
      userLimit: 500,
    },
    "Fallback room",
  );
  assert.deepEqual(preferences, {
    name: "Fallback room",
    visibility: "private",
    whitelist: ["123456"],
    userLimit: 99,
  });

  const privateOverwrites = buildVoicePermissionOverwrites({
    everyoneRoleId: "guild",
    ownerUserId: "owner",
    visibility: "private",
    whitelist: ["friend"],
  });
  assert.ok(
    privateOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel),
  );
  assert.ok(
    privateOverwrites.find((entry) => entry.id === "owner").allow.includes(
      PermissionFlagsBits.ManageChannels,
    ),
  );
  assert.ok(
    privateOverwrites.find((entry) => entry.id === "friend").allow.includes(
      PermissionFlagsBits.Connect,
    ),
  );
});

test("admin checks accept owners, Discord administrators, and configured roles", () => {
  assert.equal(
    isDiscordAdmin(
      { user: { id: "owner" } },
      { discordOwnerUserIds: ["owner"] },
    ),
    true,
  );
  assert.equal(
    isDiscordAdmin(
      {
        user: { id: "member" },
        memberPermissions: {
          has: (permission) => permission === PermissionFlagsBits.Administrator,
        },
      },
      {},
    ),
    true,
  );
  assert.equal(
    isDiscordAdmin(
      {
        user: { id: "member" },
        memberPermissions: { has: () => false },
        member: { roles: { cache: new Map([["operator", {}]]) } },
      },
      { discordAdminRoleIds: ["operator"] },
    ),
    true,
  );
  assert.equal(
    isDiscordAdmin(
      {
        user: { id: "member" },
        memberPermissions: { has: () => false },
        member: { roles: { cache: new Map() } },
      },
      {},
    ),
    false,
  );
});

test("bot stays dormant without credentials and service commands use saved IDs", async (t) => {
  const dataDir = await temporaryDirectory();
  const db = await createDatabase({ dataDir });
  t.after(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await db.saveService({
    id: "stream-overlay",
    name: "Stream overlay",
    command: "node",
    args: ["overlay.js"],
  });

  const calls = [];
  const mutableConfig = { discordAdminRoleIds: ["admin"] };
  const bot = createDiscordBot({
    config: mutableConfig,
    db,
    serviceManager: {
      start: async (serviceId) => calls.push(serviceId),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.deepEqual(await bot.start(), {
    configured: false,
    connected: false,
    enabled: false,
    started: false,
    ready: false,
    userId: null,
    username: null,
    guildId: null,
    guildName: null,
    pingMs: null,
    connectionError: null,
    connectionDiagnostic: null,
    requiresServerMembersIntent: false,
    reactiveSpeaking: false,
    reactiveVoiceChannelId: null,
    temporaryVoiceChannels: 0,
  });
  mutableConfig.discord = { token: "website-decrypted-test-token" };
  await bot.reloadSettings();
  assert.equal(bot.getStatus().configured, true);
  assert.equal(bot.getStatus().connected, false);
  assert.equal(
    JSON.stringify(bot.getStatus()).includes("website-decrypted-test-token"),
    false,
  );

  const replies = [];
  const interaction = {
    commandName: "service",
    guildId: "guild",
    user: { id: "operator" },
    memberPermissions: { has: () => false },
    member: { roles: { cache: new Map([["admin", {}]]) } },
    options: {
      getString(name) {
        return name === "action" ? "start" : "stream-overlay";
      },
    },
    isChatInputCommand: () => true,
    deferred: false,
    replied: false,
    async deferReply() {
      this.deferred = true;
    },
    async editReply(value) {
      replies.push(value);
    },
  };
  await bot.handleInteraction(interaction);
  assert.deepEqual(calls, ["stream-overlay"]);
  assert.match(replies[0], /completed/);
  assert.equal(db.listAudit({ action: "service.start" }).length, 1);
  await bot.stop();
});

test("reactive Discord discovery returns avatars, mute state, and the owner's channel", async (t) => {
  const dataDir = await temporaryDirectory();
  const db = await createDatabase({ dataDir });
  t.after(async () => {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const member = {
    id: "owner",
    displayName: "Mint",
    user: { id: "owner", username: "mint", bot: false },
    voice: {
      channelId: "voice-one",
      selfMute: true,
      serverMute: false,
      selfDeaf: false,
      serverDeaf: false,
      suppress: false,
    },
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/owner/avatar.png",
  };
  const channel = {
    id: "voice-one",
    name: "Live studio",
    members: new Map([["owner", member]]),
    isVoiceBased: () => true,
  };
  const guild = {
    id: "guild",
    name: "Forge",
    channels: {
      cache: new Map([["voice-one", channel]]),
      fetch: async () => new Map([["voice-one", channel]]),
    },
  };
  const client = {
    user: { id: "bot", username: "forge-bot" },
    ws: { ping: 12 },
    guilds: {
      cache: new Map([["guild", guild]]),
      fetch: async () => guild,
    },
    isReady: () => true,
    once() {},
    on() {},
    destroy() {},
  };
  const bot = createDiscordBot({
    config: {
      discordGuildId: "guild",
      discordOwnerUserIds: ["owner"],
      discordToken: "test-token",
    },
    db,
    client,
    logger: { info() {}, warn() {}, error() {} },
  });
  const channels = await bot.listVoiceChannels();
  assert.equal(channels[0].name, "Live studio");
  assert.equal(channels[0].members[0].selfMuted, true);
  assert.match(channels[0].members[0].avatarUrl, /cdn\.discordapp\.com/);
  const context = await bot.reactiveContext();
  assert.equal(context.selectedChannelId, "voice-one");
});
