import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { Vault } from "../src/auth.js";
import { createDatabase } from "../src/database.js";
import {
  defaultTwitchCommands,
  normalizeTwitchCommands,
  parseCommandInvocation,
  parseTwitchNotice,
  parseTwitchPrivmsg,
  TwitchManager,
} from "../src/twitch.js";

test("Twitch built-ins include uptime and parse quoted song requests", () => {
  const uptime = defaultTwitchCommands().find(
    (command) => command.trigger === "uptime",
  );
  assert.equal(uptime?.enabled, true);
  assert.equal(uptime?.action, "uptime");
  assert.deepEqual(
    parseCommandInvocation(
      '!sr "Michael Jackson - Billie Jean"',
      "!",
    ),
    {
      trigger: "sr",
      args: "Michael Jackson - Billie Jean",
    },
  );
});

test("Twitch command normalization bounds fields and removes duplicate triggers", () => {
  const commands = normalizeTwitchCommands([
    {
      trigger: "!Song",
      action: "now-playing",
      permission: "moderator",
      cooldownSeconds: 99999,
      response: "Now playing {song}",
    },
    { trigger: "song", response: "duplicate" },
    { trigger: "bad command", action: "shell" },
  ]);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].trigger, "song");
  assert.equal(commands[0].cooldownSeconds, 3600);
  assert.equal(commands[1].trigger, "badcommand");
  assert.equal(commands[1].action, "custom");
});

test("legacy Twitch settings gain new built-ins without overwriting edits", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-twitch-"));
  const db = await createDatabase({ dataDir });
  context.after(async () => {
    await db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await db.setSetting("settings:twitch", {
    commands: [{
      id: "builtin-song",
      trigger: "song",
      action: "now-playing",
      response: "My custom song reply: {song}",
      enabled: true,
    }],
  });
  const manager = new TwitchManager({
    config: { twitch: {} },
    db,
    vault: new Vault("e".repeat(64)),
    spotify: { status: () => ({}) },
    hub: { broadcast() {} },
  });
  const commands = manager.settings().commands;
  assert.equal(
    commands.find((command) => command.id === "builtin-song")?.response,
    "My custom song reply: {song}",
  );
  assert.equal(
    commands.some((command) => command.id === "builtin-uptime"),
    true,
  );
});

test("Twitch USERNOTICE parser normalizes subscriptions, gifts, and raids", () => {
  const gift = parseTwitchNotice(
    "@badge-info=;badges=;display-name=Mint;msg-id=submysterygift;msg-param-mass-gift-count=5;msg-param-sub-plan=1000;system-msg=Mint\\sgifted\\s5\\ssubs :tmi.twitch.tv USERNOTICE #forge",
  );
  assert.equal(gift.eventType, "subscription-gift");
  assert.equal(gift.user, "Mint");
  assert.equal(gift.amount, 5);
  assert.equal(gift.tier, "1000");
});

test("Twitch IRC parser retains roles and message identity", () => {
  const message = parseTwitchPrivmsg(
    "@badges=broadcaster/1,subscriber/12;color=#37E6B2;display-name=Mint;mod=0;subscriber=1 :mint!mint@mint.tmi.twitch.tv PRIVMSG #forge :!song please",
  );
  assert.equal(message.username, "mint");
  assert.equal(message.displayName, "Mint");
  assert.equal(message.channel, "forge");
  assert.equal(message.broadcaster, true);
  assert.equal(message.subscriber, true);
  assert.equal(message.message, "!song please");
});

test("Twitch manager encrypts its token and renders a live command response", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-twitch-"));
  const db = await createDatabase({ dataDir });
  context.after(async () => {
    await db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const vault = new Vault("c".repeat(64));
  const sent = [];
  const manager = new TwitchManager({
    config: { twitch: {} },
    db,
    vault,
    spotify: {
      status: () => ({
        track: { title: "Midnight Circuit", artists: ["Signal Array"] },
      }),
      requestSong: async () => null,
    },
    hub: { broadcast() {} },
    logger: { warn() {} },
  });
  await manager.updateSettings({
    enabled: false,
    channel: "forge",
    botUsername: "forge_bot",
    oauthToken: "oauth:test-secret",
    commands: [
      {
        id: "song",
        trigger: "song",
        action: "now-playing",
        response: "{user}: {song} by {artist}",
        enabled: true,
        permission: "everyone",
        cooldownSeconds: 0,
      },
    ],
  });
  const encrypted = db.getOauthToken("twitch-config");
  assert.ok(encrypted);
  assert.equal(encrypted.includes("test-secret"), false);
  manager.socket = {
    readyState: WebSocket.OPEN,
    send(value) {
      sent.push(value);
    },
  };
  const response = await manager.handleChatMessage({
    username: "viewer",
    displayName: "Viewer",
    channel: "forge",
    message: "!song",
    subscriber: false,
    moderator: false,
    broadcaster: false,
  });
  assert.equal(response, "Viewer: Midnight Circuit by Signal Array");
  assert.deepEqual(sent, [
    "PRIVMSG #forge :Viewer: Midnight Circuit by Signal Array",
  ]);
});

test("Twitch song requests preserve freeform queries and playlist falls back to album", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-twitch-"));
  const db = await createDatabase({ dataDir });
  context.after(async () => {
    await db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const requested = [];
  const sent = [];
  const manager = new TwitchManager({
    config: { twitch: {} },
    db,
    vault: new Vault("d".repeat(64)),
    spotify: {
      status: () => ({
        connected: true,
        context: { type: "album", url: null },
        track: {
          title: "Billie Jean",
          artists: ["Michael Jackson"],
          album: "Thriller",
          albumUrl: "https://open.spotify.com/album/thriller",
        },
      }),
      requestSong: async (query) => {
        requested.push(query);
        return {
          title: "Billie Jean",
          artists: ["Michael Jackson"],
        };
      },
    },
    hub: { broadcast() {} },
    logger: { warn() {} },
  });
  await manager.updateSettings({
    enabled: false,
    channel: "forge",
    botUsername: "forge_bot",
    commands: [
      {
        id: "sr",
        trigger: "sr",
        action: "song-request",
        enabled: true,
        permission: "everyone",
        cooldownSeconds: 0,
      },
      {
        id: "playlist",
        trigger: "playlist",
        action: "playlist",
        enabled: true,
        permission: "everyone",
        cooldownSeconds: 0,
      },
    ],
  });
  manager.socket = {
    readyState: WebSocket.OPEN,
    send: (value) => sent.push(value),
  };
  const message = {
    username: "viewer",
    displayName: "Viewer",
    channel: "forge",
    subscriber: false,
    moderator: false,
    broadcaster: false,
  };
  await manager.handleChatMessage({
    ...message,
    message: '!sr "Michael Jackson - Billie Jean"',
  });
  const playlistReply = await manager.handleChatMessage({
    ...message,
    message: "!playlist",
  });

  assert.deepEqual(requested, ["Michael Jackson - Billie Jean"]);
  assert.match(playlistReply, /Thriller/);
  assert.match(playlistReply, /open\.spotify\.com\/album/);
  assert.equal(sent.length, 2);
});
