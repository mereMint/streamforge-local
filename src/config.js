import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function csv(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function number(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function optional(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function loadConfig(env = process.env) {
  const host = env.HOST || "0.0.0.0";
  const port = number(env.PORT, 8787, { min: 1, max: 65535 });
  const publicBaseUrl = (env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const dataDir = path.resolve(repoRoot, env.DATA_DIR || "data");
  const tlsCertFile = optional(env.TLS_CERT_FILE);
  const tlsKeyFile = optional(env.TLS_KEY_FILE);

  return {
    repoRoot,
    host,
    port,
    publicBaseUrl,
    dataDir,
    tlsCertFile: tlsCertFile ? path.resolve(repoRoot, tlsCertFile) : null,
    tlsKeyFile: tlsKeyFile ? path.resolve(repoRoot, tlsKeyFile) : null,
    dashboardToken: optional(env.DASHBOARD_TOKEN),
    appSecret: optional(env.APP_SECRET),
    eventWebhookToken: optional(env.EVENT_WEBHOOK_TOKEN),
    serviceEditEnabled: bool(env.SERVICE_EDIT_ENABLED, false),
    statusUpdateSeconds: number(env.STATUS_UPDATE_SECONDS, 60, { min: 30, max: 3600 }),
    spotifyPollSeconds: number(env.SPOTIFY_POLL_SECONDS, 10, { min: 5, max: 300 }),
    logLevel: env.LOG_LEVEL || "info",
    discord: {
      token: optional(env.DISCORD_TOKEN),
      clientId: optional(env.DISCORD_CLIENT_ID),
      clientSecret: optional(env.DISCORD_CLIENT_SECRET),
      redirectUri: optional(env.DISCORD_REDIRECT_URI),
      guildId: optional(env.DISCORD_GUILD_ID),
      adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
      ownerUserIds: csv(env.DISCORD_OWNER_USER_IDS),
      autoRoleId: optional(env.DISCORD_AUTO_ROLE_ID),
      statusChannelId: optional(env.DISCORD_STATUS_CHANNEL_ID),
      tempVoiceLobbyId: optional(env.DISCORD_TEMP_VOICE_LOBBY_ID),
      tempVoiceCategoryId: optional(env.DISCORD_TEMP_VOICE_CATEGORY_ID),
      reactiveVoiceChannelId: optional(env.DISCORD_REACTIVE_VOICE_CHANNEL_ID),
    },
    spotify: {
      clientId: optional(env.SPOTIFY_CLIENT_ID),
      clientSecret: optional(env.SPOTIFY_CLIENT_SECRET),
      redirectUri: optional(env.SPOTIFY_REDIRECT_URI),
    },
    twitch: {
      oauthToken: optional(env.TWITCH_OAUTH_TOKEN),
    },
    rcloneRemote: optional(env.RCLONE_REMOTE),
  };
}

export function describeConfig(config) {
  return {
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    dataDir: config.dataDir,
    httpsEnabled: Boolean(config.tlsCertFile && config.tlsKeyFile),
    discordConfigured: Boolean(config.discord.token),
    discordLoginConfigured: Boolean(
      config.discord.clientId && config.discord.clientSecret && config.discord.redirectUri,
    ),
    spotifyConfigured: Boolean(
      config.spotify.clientId && config.spotify.clientSecret && config.spotify.redirectUri,
    ),
    twitchConfigured: Boolean(config.twitch?.oauthToken),
    cloudBackupConfigured: Boolean(config.rcloneRemote),
  };
}
