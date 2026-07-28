import crypto from "node:crypto";
import WebSocket from "ws";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const COMMAND_ACTIONS = new Set([
  "custom",
  "now-playing",
  "playlist",
  "song-request",
  "uptime",
]);
const COMMAND_PERMISSIONS = new Set(["everyone", "subscriber", "moderator", "broadcaster"]);
const MAX_COMMANDS = 100;

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function safeCommandName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[!/.]+/, "")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

export function defaultTwitchCommands() {
  return [
    {
      id: "builtin-song",
      trigger: "song",
      action: "now-playing",
      response: "Now playing: {song} — {artist}",
      enabled: true,
      permission: "everyone",
      cooldownSeconds: 10,
    },
    {
      id: "builtin-playlist",
      trigger: "playlist",
      action: "playlist",
      response: "Stream playlist: {playlist}",
      enabled: true,
      permission: "everyone",
      cooldownSeconds: 20,
    },
    {
      id: "builtin-uptime",
      trigger: "uptime",
      action: "uptime",
      response: "StreamForge has been online for {uptime}.",
      enabled: true,
      permission: "everyone",
      cooldownSeconds: 10,
    },
    {
      id: "builtin-song-request",
      trigger: "sr",
      action: "song-request",
      response: "{user}, queued {song}.",
      enabled: false,
      permission: "everyone",
      cooldownSeconds: 30,
    },
  ];
}

export function normalizeTwitchCommands(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set();
  const commands = [];
  for (const item of source.slice(0, MAX_COMMANDS)) {
    const trigger = safeCommandName(item?.trigger);
    if (!trigger || seen.has(trigger)) continue;
    seen.add(trigger);
    const action = COMMAND_ACTIONS.has(item?.action) ? item.action : "custom";
    const permission = COMMAND_PERMISSIONS.has(item?.permission)
      ? item.permission
      : "everyone";
    commands.push({
      id: String(item?.id || crypto.randomUUID()).slice(0, 80),
      trigger,
      action,
      response: String(item?.response || "").trim().slice(0, 450),
      enabled: item?.enabled !== false,
      permission,
      cooldownSeconds: boundedNumber(item?.cooldownSeconds, 10, 0, 3600),
    });
  }
  return commands;
}

function decodeTag(value = "") {
  return String(value)
    .replaceAll("\\s", " ")
    .replaceAll("\\:", ";")
    .replaceAll("\\r", "\r")
    .replaceAll("\\n", "\n")
    .replaceAll("\\\\", "\\");
}

function parseTags(value = "") {
  return Object.fromEntries(
    String(value)
      .split(";")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return separator === -1
          ? [entry, ""]
          : [entry.slice(0, separator), decodeTag(entry.slice(separator + 1))];
      }),
  );
}

export function parseTwitchPrivmsg(line) {
  const match = String(line).match(
    /^(?:@([^ ]+) )?:([^! ]+)!.* PRIVMSG #([^ ]+) :([\s\S]*)$/,
  );
  if (!match) return null;
  const tags = parseTags(match[1] || "");
  return {
    username: match[2].toLowerCase(),
    displayName: tags["display-name"] || match[2],
    channel: match[3].toLowerCase(),
    message: match[4],
    badges: String(tags.badges || "")
      .split(",")
      .filter(Boolean)
      .map((badge) => badge.split("/")[0]),
    subscriber: tags.subscriber === "1",
    moderator: tags.mod === "1" || String(tags.badges || "").includes("moderator/"),
    broadcaster: String(tags.badges || "").includes("broadcaster/"),
    bits: boundedNumber(tags.bits, 0, 0, 10_000_000),
  };
}

export function parseTwitchNotice(line) {
  const match = String(line).match(
    /^@([^ ]+) :[^ ]+ USERNOTICE #([^ ]+)(?: :([\s\S]*))?$/,
  );
  if (!match) return null;
  const tags = parseTags(match[1]);
  const notice = String(tags["msg-id"] || "").toLowerCase();
  const eventType = {
    sub: "subscription",
    resub: "resub",
    subgift: "subscription-gift",
    anonsubgift: "subscription-gift",
    submysterygift: "subscription-gift",
    giftpaidupgrade: "subscription",
    anongiftpaidupgrade: "subscription",
    raid: "raid",
    ritual: "ritual",
  }[notice];
  if (!eventType) return null;
  return {
    eventType,
    channel: match[2].toLowerCase(),
    user:
      tags["display-name"] ||
      tags["msg-param-displayName"] ||
      tags["msg-param-sender-name"] ||
      "Anonymous",
    message: match[3] || tags["system-msg"] || "",
    amount: boundedNumber(
      tags["msg-param-mass-gift-count"] ||
        tags["msg-param-months"] ||
        tags["msg-param-viewerCount"],
      0,
      0,
      10_000_000,
    ),
    tier: tags["msg-param-sub-plan"] || null,
  };
}

function canRun(command, message) {
  if (command.permission === "broadcaster") return message.broadcaster;
  if (command.permission === "moderator") {
    return message.broadcaster || message.moderator;
  }
  if (command.permission === "subscriber") {
    return message.broadcaster || message.moderator || message.subscriber;
  }
  return true;
}

function applyTemplate(template, values) {
  let output = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return output.replace(/\s+/g, " ").trim().slice(0, 450);
}

export function parseCommandInvocation(message, prefix = "!") {
  const content = String(message || "");
  if (!content.startsWith(prefix)) return null;
  const invocation = content.slice(prefix.length).trim();
  if (!invocation) return null;
  const separator = invocation.search(/\s/);
  const rawTrigger =
    separator === -1 ? invocation : invocation.slice(0, separator);
  let args = separator === -1 ? "" : invocation.slice(separator).trim();
  if (
    args.length >= 2 &&
    ((args.startsWith('"') && args.endsWith('"')) ||
      (args.startsWith("'") && args.endsWith("'")))
  ) {
    args = args.slice(1, -1).trim();
  }
  return { trigger: safeCommandName(rawTrigger), args };
}

function durationLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function spotifyPlaylistFallback(spotifyStatus, configuredUrl) {
  if (configuredUrl) {
    return { value: configuredUrl, response: "Stream playlist: {playlist}" };
  }
  if (
    spotifyStatus?.context?.type === "playlist" &&
    spotifyStatus.context.url
  ) {
    return {
      value: spotifyStatus.context.url,
      response: "Current Spotify playlist: {playlist}",
    };
  }
  if (spotifyStatus?.track?.albumUrl) {
    return {
      value: `${spotifyStatus.track.album || "Current album"} — ${spotifyStatus.track.albumUrl}`,
      response: "Current Spotify album: {playlist}",
    };
  }
  if (spotifyStatus?.track?.url) {
    return {
      value: spotifyStatus.track.url,
      response: "Current Spotify track: {playlist}",
    };
  }
  return {
    value: "No Spotify playlist, album, or track is available",
    response: "{playlist}",
  };
}

export class TwitchManager {
  constructor({ config, db, vault, spotify, hub, logger = console }) {
    this.config = config;
    this.db = db;
    this.vault = vault;
    this.spotify = spotify;
    this.hub = hub;
    this.logger = logger;
    this.socket = null;
    this.reconnectTimer = null;
    this.explicitStop = false;
    this.connected = false;
    this.connectionError = null;
    this.cooldowns = new Map();
    this.lastConnectedAt = null;
    this.lastMessageAt = null;
    this.reconnectAttempts = 0;
  }

  settings() {
    const stored = this.db.getSetting("settings:twitch", {});
    const storedCommands = normalizeTwitchCommands(stored.commands);
    const commands = [...storedCommands];
    for (const builtIn of defaultTwitchCommands()) {
      if (
        commands.some(
          (command) =>
            command.id === builtIn.id || command.trigger === builtIn.trigger,
        )
      ) {
        continue;
      }
      commands.push(builtIn);
    }
    return {
      enabled: Boolean(stored.enabled),
      channel: safeCommandName(stored.channel),
      botUsername: safeCommandName(stored.botUsername),
      commandPrefix: String(stored.commandPrefix || "!").slice(0, 1) || "!",
      playlistUrl: String(stored.playlistUrl || "").trim().slice(0, 500),
      commands,
    };
  }

  secrets() {
    const encrypted = this.db.getOauthToken("twitch-config");
    if (encrypted) return this.vault.decrypt(encrypted);
    return { oauthToken: this.config.twitch?.oauthToken || "" };
  }

  configured() {
    const settings = this.settings();
    const secrets = this.secrets();
    return Boolean(
      settings.enabled &&
        settings.channel &&
        settings.botUsername &&
        secrets.oauthToken,
    );
  }

  status() {
    const settings = this.settings();
    return {
      configured: this.configured(),
      connected: this.connected,
      enabled: settings.enabled,
      channel: settings.channel || null,
      botUsername: settings.botUsername || null,
      commandCount: settings.commands.filter((command) => command.enabled).length,
      oauthTokenConfigured: Boolean(this.secrets().oauthToken),
      connectionError: this.connectionError,
      connectionState: this.connected
        ? "connected"
        : this.socket
          ? "connecting"
          : settings.enabled
            ? "disconnected"
            : "disabled",
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  publicSettings() {
    const settings = this.settings();
    return {
      ...settings,
      oauthTokenConfigured: Boolean(this.secrets().oauthToken),
    };
  }

  async updateSettings(input = {}) {
    const previous = this.settings();
    const previousSecrets = this.secrets();
    const settings = {
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : previous.enabled,
      channel: safeCommandName(input.channel ?? previous.channel),
      botUsername: safeCommandName(input.botUsername ?? previous.botUsername),
      commandPrefix:
        String(input.commandPrefix ?? previous.commandPrefix ?? "!").slice(0, 1) || "!",
      playlistUrl: String(input.playlistUrl ?? previous.playlistUrl ?? "")
        .trim()
        .slice(0, 500),
      commands: normalizeTwitchCommands(input.commands ?? previous.commands),
    };
    const secrets = {
      oauthToken: input.clearOauthToken
        ? ""
        : String(input.oauthToken || previousSecrets.oauthToken || "").trim(),
    };
    await this.db.setSetting("settings:twitch", settings);
    if (secrets.oauthToken) {
      await this.db.saveOauthToken("twitch-config", this.vault.encrypt(secrets));
    } else {
      await this.db.deleteOauthToken("twitch-config");
    }
    await this.restart();
    return { settings: this.publicSettings(), status: this.status() };
  }

  async start() {
    this.explicitStop = false;
    if (!this.configured() || this.socket) return this.status();
    const settings = this.settings();
    const token = String(this.secrets().oauthToken || "").replace(/^oauth:/i, "");
    const socket = new WebSocket(IRC_URL);
    this.socket = socket;

    socket.on("open", () => {
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      socket.send(`PASS oauth:${token}`);
      socket.send(`NICK ${settings.botUsername}`);
      socket.send(`JOIN #${settings.channel}`);
    });
    socket.on("message", (buffer) => {
      for (const line of String(buffer).split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith("PING")) {
          socket.send(line.replace(/^PING/, "PONG"));
          continue;
        }
        if (line.includes(" 001 ")) {
          this.connected = true;
          this.connectionError = null;
          this.lastConnectedAt = new Date().toISOString();
          this.reconnectAttempts = 0;
          this.hub.broadcast("twitch", "twitch.status", this.status());
        }
        const message = parseTwitchPrivmsg(line);
        if (message) {
          this.lastMessageAt = new Date().toISOString();
          if (message.bits > 0) {
            this.publishAlert({
              eventType: "bits",
              user: message.displayName,
              message: message.message,
              amount: message.bits,
            });
          }
          void this.handleChatMessage(message);
        }
        const notice = parseTwitchNotice(line);
        if (notice) this.publishAlert(notice);
        if (line.includes(" NOTICE ") && /authentication failed|improperly formatted/i.test(line)) {
          this.connectionError = "Twitch rejected the bot login token.";
        }
      }
    });
    socket.on("error", (error) => {
      this.connectionError = error.message;
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.connected = false;
      this.hub.broadcast("twitch", "twitch.status", this.status());
      if (!this.explicitStop && this.configured()) {
        this.reconnectAttempts += 1;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.start(), 5_000);
        this.reconnectTimer.unref?.();
      }
    });
    return this.status();
  }

  async stop() {
    this.explicitStop = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.connected = false;
    return this.status();
  }

  async restart() {
    await this.stop();
    this.explicitStop = false;
    return this.start();
  }

  async handleChatMessage(message) {
    const settings = this.settings();
    if (
      !message?.message?.startsWith(settings.commandPrefix) ||
      message.username === settings.botUsername
    ) {
      return null;
    }
    const invocation = parseCommandInvocation(
      message.message,
      settings.commandPrefix,
    );
    if (!invocation) return null;
    const { trigger, args } = invocation;
    const command = settings.commands.find(
      (candidate) => candidate.enabled && candidate.trigger === trigger,
    );
    if (!command || !canRun(command, message)) return null;
    const cooldownKey = `${message.channel}:${trigger}`;
    const nextAllowed = this.cooldowns.get(cooldownKey) || 0;
    if (Date.now() < nextAllowed) return null;
    this.cooldowns.set(cooldownKey, Date.now() + command.cooldownSeconds * 1_000);

    const spotifyStatus = this.spotify.status();
    const track = spotifyStatus.track;
    let requestedTrack = null;
    if (command.action === "song-request") {
      if (!args) {
        return this.sendMessage(
          message.channel,
          `${message.displayName}, use ${settings.commandPrefix}${command.trigger} artist - song`,
        );
      }
      try {
        requestedTrack = await this.spotify.requestSong(args);
      } catch (error) {
        return this.sendMessage(
          message.channel,
          `${message.displayName}, request failed: ${error.message}`,
        );
      }
    }
    const song = requestedTrack?.title || track?.title || "Nothing is playing";
    const artist =
      requestedTrack?.artists?.join(", ") || track?.artists?.join(", ") || "";
    const playlist = spotifyPlaylistFallback(
      spotifyStatus,
      settings.playlistUrl,
    );
    const defaults = {
      custom: command.response || "{user}: {args}",
      "now-playing": command.response || "Now playing: {song} — {artist}",
      playlist: command.response || playlist.response,
      "song-request": command.response || "{user}, queued {song}.",
      uptime: command.response || "StreamForge has been online for {uptime}.",
    };
    const response = applyTemplate(defaults[command.action], {
      user: message.displayName || message.username,
      username: message.username,
      args,
      song,
      artist,
      playlist: playlist.value,
      uptime: durationLabel(process.uptime()),
      channel: message.channel,
    });
    return this.sendMessage(message.channel, response);
  }

  publishAlert(event) {
    for (const profile of this.db.listOverlays("alerts")) {
      const profileConfig = profile.config || {};
      const enabledTypes = Array.isArray(profileConfig.eventTypes)
        ? profileConfig.eventTypes
        : [];
      if (
        profileConfig.listenAllEvents === false ||
        (enabledTypes.length && !enabledTypes.includes(event.eventType))
      ) continue;
      this.hub.broadcast(`alerts:${profile.id}`, `twitch.${event.eventType}`, {
        ...event,
        event: event.eventType,
      });
    }
    this.hub.broadcast("twitch", `twitch.${event.eventType}`, event);
  }

  sendMessage(channel, message) {
    const output = String(message || "").replace(/[\r\n]/g, " ").trim().slice(0, 450);
    if (!output) return null;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.logger.warn?.("[twitch] Command response skipped because chat is disconnected");
      return null;
    }
    this.socket.send(`PRIVMSG #${safeCommandName(channel)} :${output}`);
    this.hub.broadcast("twitch", "twitch.command", { channel, message: output });
    return output;
  }
}

export default TwitchManager;
