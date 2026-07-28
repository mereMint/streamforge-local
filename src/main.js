import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AuthManager, Vault } from "./auth.js";
import { BackupManager } from "./backup-manager.js";
import { loadConfig, describeConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createDiscordBot } from "./discord-bot.js";
import { createHttpServer } from "./http-server.js";
import { RealtimeHub } from "./realtime.js";
import { ServiceManager } from "./service-manager.js";
import { SpotifyManager } from "./spotify.js";
import { TwitchManager } from "./twitch.js";

function localAddresses(port, protocol = "http:") {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(`${protocol}//${entry.address}:${port}`);
      }
    }
  }
  return [...new Set(addresses)];
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function bootstrap() {
  const config = loadConfig();
  if (!config.dashboardToken || config.dashboardToken.length < 24) {
    throw new Error("DASHBOARD_TOKEN must be set to at least 24 random characters.");
  }
  if (!config.appSecret || config.appSecret.length < 32) {
    throw new Error("APP_SECRET must be set to at least 32 random characters.");
  }

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(config.dataDir, "uploads"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(config.dataDir, "backups"), { recursive: true, mode: 0o700 });

  const db = await createDatabase({ dataDir: config.dataDir });
  const hub = new RealtimeHub();
  const vault = new Vault(config.appSecret);
  const savedDiscord = db.getSetting("settings:discord", {});
  const savedDiscordCiphertext = db.getOauthToken("discord-config");
  const savedDiscordSecrets = savedDiscordCiphertext
    ? vault.decrypt(savedDiscordCiphertext)
    : {};
  if (savedDiscord && typeof savedDiscord === "object") {
    Object.assign(config.discord, savedDiscord);
  }
  Object.assign(config.discord, savedDiscordSecrets);
  const savedSpotify = db.getSetting("settings:spotify", {});
  const savedSpotifyCiphertext = db.getOauthToken("spotify-config");
  const savedSpotifySecrets = savedSpotifyCiphertext
    ? vault.decrypt(savedSpotifyCiphertext)
    : {};
  Object.assign(config.spotify, savedSpotify, savedSpotifySecrets);
  const auth = new AuthManager(config);
  const backups = new BackupManager(config);

  let discord;
  let spotify;
  let twitch;
  let services;

  const getStatus = async () => {
    const memory = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return {
      ok: true,
      name: "StreamForge Local",
      version: "0.1.0",
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      host: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        load: os.loadavg().map((value) => Number(value.toFixed(2))),
        memory: {
          usedBytes: totalMemory - freeMemory,
          totalBytes: totalMemory,
          processBytes: memory.rss,
        },
      },
      urls: localAddresses(config.port, new URL(config.publicBaseUrl).protocol),
      services: services ? await services.list() : [],
      discord: discord?.status?.() || { configured: false, connected: false },
      spotify: spotify?.status?.() || { configured: false, connected: false },
      twitch: twitch?.status?.() || { configured: false, connected: false },
      backup: backups.status(),
      config: describeConfig(config),
    };
  };

  services = new ServiceManager({
    config,
    db,
    onChange: () => hub.broadcast("status", "status-changed", { source: "services" }),
  });
  spotify = new SpotifyManager({ config, db, vault, hub });
  twitch = new TwitchManager({ config, db, vault, spotify, hub });
  discord = createDiscordBot({
    config,
    db,
    serviceManager: services,
    broadcast: (topic, type, payload) => {
      hub.broadcast(topic, type, payload);
      if (type === "discord.speaking" || type === "discord.voice.snapshot") {
        for (const profile of db.listOverlays("reactives")) {
          const targetChannelId =
            profile.config?.voiceChannelId || config.discord.reactiveVoiceChannelId;
          if (!targetChannelId || String(targetChannelId) === String(payload.channelId)) {
            hub.broadcast(`reactives:${profile.id}`, type, payload);
          }
        }
      }
    },
    getStatus,
  });

  const server = createHttpServer({
    config,
    auth,
    vault,
    db,
    services,
    backups,
    spotify,
    twitch,
    discord,
    hub,
    getStatus,
  });

  await listen(server, config.host, config.port);
  await services.startAutostart();
  spotify.start();
  await twitch.start();
  await discord.start();

  console.log("StreamForge Local is running.");
  console.log(`Local dashboard: ${config.publicBaseUrl}`);
  for (const url of localAddresses(config.port, new URL(config.publicBaseUrl).protocol)) {
    console.log(`LAN dashboard:   ${url}`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping after ${signal}...`);
    spotify.stop();
    hub.close();
    await Promise.allSettled([
      twitch.stop(),
      discord.stop(),
      services.stopAll(),
      new Promise((resolve) => server.close(resolve)),
    ]);
    await db.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal)
        .catch((error) => {
          console.error("Shutdown failed:", error);
          process.exitCode = 1;
        })
        .finally(() => process.exit());
    });
  }

  return { config, db, server, discord, services, spotify, twitch, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bootstrap().catch((error) => {
    console.error("StreamForge Local could not start:", error);
    process.exitCode = 1;
  });
}

export { bootstrap, localAddresses, listen };
