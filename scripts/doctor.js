import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadConfig } from "../src/config.js";

const require = createRequire(import.meta.url);
const config = loadConfig();
const results = [];
const requireRunning = process.argv.includes("--require-running");

function report(level, area, message) {
  results.push({ level, area, message });
}

function commandExists(command) {
  const checker = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [command] : ["-lc", `command -v "$1" >/dev/null`, "sh", command];
  return spawnSync(checker, args, { stdio: "ignore" }).status === 0;
}

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 12)) {
  report("ok", "runtime", `Node ${process.versions.node}`);
} else {
  report("error", "runtime", `Node 22.12+ is required; found ${process.versions.node}`);
}

for (const packageName of ["discord.js", "@discordjs/voice", "sql.js", "ws"]) {
  try {
    require.resolve(packageName);
    report("ok", "packages", packageName);
  } catch {
    report("error", "packages", `${packageName} is missing; run npm ci --omit=dev`);
  }
}

if (config.dashboardToken?.length >= 24) {
  report("ok", "security", "dashboard access key is configured");
} else {
  report("error", "security", "DASHBOARD_TOKEN must contain at least 24 random characters");
}

if (config.appSecret?.length >= 32) {
  report("ok", "security", "application encryption key is configured");
} else {
  report("error", "security", "APP_SECRET must contain at least 32 random characters");
}

if (config.tlsCertFile || config.tlsKeyFile) {
  if (!(config.tlsCertFile && config.tlsKeyFile)) {
    report("error", "https", "TLS_CERT_FILE and TLS_KEY_FILE must be set together");
  } else if (!fs.existsSync(config.tlsCertFile) || !fs.existsSync(config.tlsKeyFile)) {
    report("error", "https", "the configured TLS certificate or key file does not exist");
  } else if (!config.publicBaseUrl.startsWith("https://")) {
    report("error", "https", "PUBLIC_BASE_URL must start with https:// when direct TLS is enabled");
  } else {
    report("ok", "https", "direct TLS certificate and key are present");
  }
} else {
  report("warn", "https", "dashboard is LAN HTTP unless a trusted HTTPS proxy is used");
}

try {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const probe = path.join(config.dataDir, ".doctor-write-test");
  fs.writeFileSync(probe, "ok", { mode: 0o600 });
  fs.rmSync(probe);
  report("ok", "storage", config.dataDir);
} catch (error) {
  report("error", "storage", `data directory is not writable: ${error.message}`);
}

if (config.discord.token) {
  if (config.discord.guildId) report("ok", "discord", "bot token and guild id are configured");
  else report("error", "discord", "DISCORD_GUILD_ID is required when the bot is enabled");
  if (config.discord.ownerUserIds.length || config.discord.adminRoleIds.length) {
    report("ok", "discord", "admin allowlist is configured");
  } else {
    report("warn", "discord", "set an owner user id or admin role before enabling Discord login");
  }
  if (config.discord.tempVoiceLobbyId && config.discord.tempVoiceCategoryId) {
    report("ok", "discord voice", "temporary voice lobby and category are configured");
  } else {
    report("warn", "discord voice", "temporary voice channels are not configured yet");
  }
} else {
  report("warn", "discord", "bot is dormant until DISCORD_TOKEN is set");
}

if (config.spotify.clientId || config.spotify.clientSecret || config.spotify.redirectUri) {
  if (!(config.spotify.clientId && config.spotify.clientSecret && config.spotify.redirectUri)) {
    report("error", "spotify", "client id, secret, and redirect URI must all be set");
  } else {
    try {
      const redirect = new URL(config.spotify.redirectUri);
      const permittedLoopback =
        redirect.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(redirect.hostname);
      if (redirect.protocol === "https:" || permittedLoopback) {
        report("ok", "spotify", "redirect URI uses HTTPS or Spotify's explicit loopback exception");
      } else {
        report("error", "spotify", "redirect URI must use HTTPS; LAN HTTP addresses are rejected");
      }
    } catch {
      report("error", "spotify", "redirect URI is not a valid URL");
    }
  }
} else {
  report("warn", "spotify", "now-playing is dormant until Spotify OAuth is configured");
}

for (const command of ["bash", "ssh", "rclone"]) {
  report(
    commandExists(command) ? "ok" : "warn",
    "system command",
    commandExists(command) ? command : `${command} is unavailable`,
  );
}

try {
  const response = await fetch(`${config.publicBaseUrl}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  report("ok", "server", `${config.publicBaseUrl}/health responded`);
  const statusResponse = await fetch(`${config.publicBaseUrl}/api/status`, {
    headers: { authorization: `Bearer ${config.dashboardToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (statusResponse.ok) {
    const status = await statusResponse.json();
    if (status.discord?.enabled) {
      report(
        status.discord.ready ? "ok" : "warn",
        "discord live",
        status.discord.ready ? "bot is connected" : "bot is configured but not connected",
      );
    }
    if (status.spotify?.configured) {
      report(
        status.spotify.connected ? "ok" : "warn",
        "spotify live",
        status.spotify.connected ? "now-playing is connected" : "Spotify needs authorization",
      );
    }
  }
} catch (error) {
  report(
    requireRunning ? "error" : "warn",
    "server",
    `health check failed: ${error.message}`,
  );
}

if (config.rcloneRemote) {
  report(
    commandExists("rclone") ? "ok" : "error",
    "backup",
    commandExists("rclone")
      ? `cloud destination is configured (${config.rcloneRemote})`
      : "RCLONE_REMOTE is set but rclone is missing",
  );
} else {
  report("warn", "backup", "cloud upload is dormant; local backups remain available");
}

const symbols = { ok: "[OK]", warn: "[--]", error: "[!!]" };
for (const result of results) {
  console.log(`${symbols[result.level]} ${result.area}: ${result.message}`);
}

const errors = results.filter((result) => result.level === "error").length;
const warnings = results.filter((result) => result.level === "warn").length;
console.log(`\nDoctor finished with ${errors} error(s) and ${warnings} optional warning(s).`);
if (errors) process.exitCode = 1;
