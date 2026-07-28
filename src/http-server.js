import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const PROFILE_TYPES = new Set(["chat", "alerts", "reactives", "timer", "spotify"]);
const SETTINGS_SCOPES = new Set(["general", "discord", "spotify", "twitch", "backup"]);
const DISCORD_SETTING_KEYS = [
  "clientId",
  "redirectUri",
  "guildId",
  "adminRoleIds",
  "ownerUserIds",
  "autoRoleId",
  "statusChannelId",
  "tempVoiceLobbyId",
  "tempVoiceCategoryId",
  "reactiveVoiceChannelId",
];
const JSON_LIMIT = 2 * 1024 * 1024;

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { location, "cache-control": "no-store", ...headers });
  response.end();
}

function text(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function parseStored(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeProfile(type, body, id = crypto.randomUUID()) {
  if (!PROFILE_TYPES.has(type)) throw new Error("Unknown overlay profile type.");
  const name = String(body.name || `${type} profile`).trim().slice(0, 80);
  const config = body.config && typeof body.config === "object" ? body.config : body;
  return { id, type, kind: type, name, config };
}

function timingSafeToken(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function discordPublicSettings(input = {}) {
  return Object.fromEntries(
    DISCORD_SETTING_KEYS.filter((key) => input[key] !== undefined).map((key) => {
      const value = input[key];
      if (key.endsWith("Ids")) {
        const list = Array.isArray(value)
          ? value
          : String(value ?? "")
              .split(",")
              .map((item) => item.trim());
        return [key, [...new Set(list.map(String).filter(Boolean))].slice(0, 100)];
      }
      return [key, value == null ? "" : String(value).trim().slice(0, 500)];
    }),
  );
}

function spotifyPublicSettings(input = {}) {
  return {
    clientId: String(input.clientId || "").trim().slice(0, 200),
    redirectUri: String(input.redirectUri || "").trim().slice(0, 500),
  };
}

function timerState(profile) {
  const config = parseStored(profile.config, {});
  const durationSeconds = Math.max(
    0,
    Number(config.startingSeconds ?? config.durationSeconds ?? 3600),
  );
  return {
    ...config.timerState,
    running: Boolean(config.timerState?.running),
    remainingMs: Number(config.timerState?.remainingMs ?? durationSeconds * 1000),
    endAt: config.timerState?.endAt || null,
    updatedAt: config.timerState?.updatedAt || new Date().toISOString(),
  };
}

function currentRemaining(state) {
  if (!state.running || !state.endAt) return Math.max(0, state.remainingMs);
  return Math.max(0, new Date(state.endAt).getTime() - Date.now());
}

async function updateTimer({ db, hub }, id, body) {
  const profile = await db.getOverlay("timer", id);
  if (!profile) {
    const error = new Error("Timer profile not found.");
    error.statusCode = 404;
    throw error;
  }
  const config = parseStored(profile.config, {});
  const previous = timerState(profile);
  let remainingMs = currentRemaining(previous);
  let running = previous.running;

  if (body.action === "start") running = true;
  else if (body.action === "pause") running = false;
  else if (body.action === "reset") {
    running = false;
    remainingMs = Math.max(
      0,
      Number(config.startingSeconds ?? config.durationSeconds ?? 3600) * 1000,
    );
  } else if (body.action === "add") {
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31_536_000) {
      const error = new Error("Timer seconds must be a positive finite value.");
      error.statusCode = 400;
      throw error;
    }
    remainingMs += Math.round(seconds * 1000);
  } else if (body.action === "subtract") {
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 31_536_000) {
      const error = new Error("Timer seconds must be a positive finite value.");
      error.statusCode = 400;
      throw error;
    }
    remainingMs = Math.max(0, remainingMs - Math.round(seconds * 1000));
  } else {
    const error = new Error("Unknown timer action.");
    error.statusCode = 400;
    throw error;
  }
  if (remainingMs <= 0) running = false;

  const state = {
    running,
    remainingMs,
    endAt: running ? new Date(Date.now() + remainingMs).toISOString() : null,
    updatedAt: new Date().toISOString(),
    eventCount:
      body.action === "reset"
        ? 0
        : Math.max(
            0,
            Number(previous.eventCount || 0) +
              (body.action === "add" && body.countEvent !== false
                ? Math.max(1, Number(body.eventCount || 1))
                : 0),
          ),
    lastEvent: body.event || previous.lastEvent || null,
  };
  const saved = {
    ...profile,
    config: { ...config, timerState: state },
  };
  await db.saveOverlay(saved);
  hub.broadcast(`timer:${id}`, "timer", state);
  return state;
}

export function createHttpServer({
  config,
  auth,
  vault,
  db,
  services,
  backups,
  spotify,
  twitch = null,
  discord,
  hub,
  getStatus,
}) {
  const webRoot = path.join(config.repoRoot, "web");

  const listener = async (request, response) => {
    const requestUrl = new URL(request.url, config.publicBaseUrl);
    const pathname = decodeURIComponent(requestUrl.pathname);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "same-origin");
    response.setHeader("x-frame-options", "SAMEORIGIN");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss://irc-ws.chat.twitch.tv https://api.betterttv.net https://api.frankerfacez.com https://7tv.io; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );

    try {
      if (request.method === "GET" && pathname === "/health") {
        return json(response, 200, { ok: true, uptime: Math.round(process.uptime()) });
      }

      if (request.method === "GET" && pathname === "/auth/discord") {
        const location = auth.discordAuthorizeUrl(requestUrl.searchParams.get("returnTo") || "/");
        if (!location) return text(response, 503, "Discord login is not configured.");
        return redirect(response, location);
      }

      if (request.method === "GET" && pathname === "/auth/discord/callback") {
        const result = await auth.completeDiscordLogin(
          requestUrl.searchParams.get("code"),
          requestUrl.searchParams.get("state"),
        );
        return redirect(response, result.returnTo, { "set-cookie": result.cookie });
      }

      if (request.method === "GET" && pathname === "/auth/spotify/callback") {
        const state = auth.verifyOAuthState(requestUrl.searchParams.get("state"), "spotify");
        if (!state) throw new Error("Spotify login state is invalid or expired.");
        await spotify.completeAuthorization(requestUrl.searchParams.get("code"));
        return redirect(response, "/?view=spotify&linked=1");
      }

      if (request.method === "GET" && pathname.startsWith("/api/public/profiles/")) {
        const match = pathname.match(/^\/api\/public\/profiles\/([^/]+)\/([^/]+)$/);
        if (!match || !PROFILE_TYPES.has(match[1])) return json(response, 404, { error: "Not found" });
        const profile = await db.getOverlay(match[1], match[2]);
        if (!profile) return json(response, 404, { error: "Profile not found" });
        return json(response, 200, { profile });
      }

      if (request.method === "GET" && pathname.startsWith("/api/public/timer/")) {
        const id = pathname.slice("/api/public/timer/".length);
        const profile = await db.getOverlay("timer", id);
        if (!profile) return json(response, 404, { error: "Timer profile not found" });
        const state = timerState(profile);
        return json(response, 200, {
          ...state,
          remainingMs: currentRemaining(state),
          updatedAt: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && pathname.startsWith("/api/public/reactives/")) {
        const id = pathname.slice("/api/public/reactives/".length).replace(/\/state$/, "");
        const profile = await db.getOverlay("reactives", id);
        if (!profile) return json(response, 404, { error: "Reactive profile not found" });
        const channelId =
          parseStored(profile.config, {}).voiceChannelId ||
          config.discord.reactiveVoiceChannelId;
        const channels = (await discord.listVoiceChannels?.()) || [];
        const channel = channels.find((candidate) => String(candidate.id) === String(channelId));
        return json(response, 200, {
          channelId: channel?.id || channelId || null,
          channelName: channel?.name || null,
          members: channel?.members || [],
          connected: Boolean(discord.status().reactiveSpeaking),
          updatedAt: new Date().toISOString(),
        });
      }

      if (request.method === "GET" && pathname === "/api/public/spotify/now-playing") {
        return json(response, 200, spotify.status());
      }

      if (request.method === "POST" && pathname === "/api/events") {
        const bearer = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (!timingSafeToken(bearer, config.eventWebhookToken)) {
          return json(response, 401, { error: "Invalid event webhook token" });
        }
        const body = await readJson(request);
        const eventType = String(body.type || "custom")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]/g, "-")
          .slice(0, 80);
        const alertProfiles = body.alertProfileId
          ? [await db.getOverlay("alerts", body.alertProfileId)].filter(Boolean)
          : (await db.listOverlays("alerts")).filter((profile) => {
              const profileConfig = parseStored(profile.config, {});
              const enabledTypes = Array.isArray(profileConfig.eventTypes)
                ? profileConfig.eventTypes
                : [];
              return (
                profileConfig.listenAllEvents !== false &&
                (!enabledTypes.length || enabledTypes.includes(eventType))
              );
            });
        for (const profile of alertProfiles) {
          hub.broadcast(`alerts:${profile.id}`, `twitch.${eventType}`, {
            event: eventType,
            eventType,
            user: body.user || body.username || body.displayName || "",
            title: body.title || eventType || "Stream event",
            message: body.message || "",
            image: body.image || null,
            amount: body.amount ?? body.bits ?? body.viewers ?? body.count ?? null,
            raw: body.data && typeof body.data === "object" ? body.data : undefined,
          });
        }
        const timerProfiles = body.timerProfileId
          ? [await db.getOverlay("timer", body.timerProfileId)].filter(Boolean)
          : (await db.listOverlays("timer")).filter((profile) => {
              const timerConfig = parseStored(profile.config, {});
              return timerConfig.eventType === eventType;
            });
        const timers = [];
        for (const profile of timerProfiles) {
          const timerConfig = parseStored(profile.config, {});
          const seconds = Number(body.seconds ?? timerConfig.secondsPerEvent);
          if (!Number.isFinite(seconds) || seconds <= 0) continue;
          timers.push(
            await updateTimer(
              { db, hub },
              profile.id,
              {
                action: "add",
                seconds,
                event: eventType,
                eventCount: Number(body.count || 1),
              },
            ),
          );
        }
        return json(response, 202, {
          ok: true,
          alertProfiles: alertProfiles.map((profile) => profile.id),
          timers,
        });
      }

      if (pathname === "/api/auth/session" && request.method === "GET") {
        const session = auth.sessionFromRequest(request);
        return json(response, 200, {
          authenticated: Boolean(session),
          user: session
            ? { id: session.sub, name: session.name, provider: session.provider }
            : null,
          discordLoginAvailable: Boolean(auth.discordAuthorizeUrl("/")),
        });
      }

      if (pathname === "/api/auth/login" && request.method === "POST") {
        const body = await readJson(request);
        const session = auth.authenticateAccessKey(body.accessKey);
        if (!session) return json(response, 401, { error: "The access key is not valid." });
        return json(response, 200, { ok: true }, { "set-cookie": auth.sessionCookie(session) });
      }

      if (pathname === "/api/auth/logout" && request.method === "POST") {
        return json(response, 200, { ok: true }, { "set-cookie": auth.clearSessionCookie() });
      }

      const session = pathname.startsWith("/api/") ? auth.sessionFromRequest(request) : null;
      if (pathname.startsWith("/api/") && !session) {
        return json(response, 401, { error: "Authentication required" });
      }

      if (pathname === "/api/status" && request.method === "GET") {
        return json(response, 200, await getStatus());
      }

      if (pathname === "/api/spotify/connect" && request.method === "GET") {
        const state = auth.createOAuthState("spotify", "/?view=spotify");
        const location = spotify.authorizationUrl(state);
        if (!location) return json(response, 503, { error: "Spotify is not configured." });
        return redirect(response, location);
      }

      if (pathname === "/api/spotify/disconnect" && request.method === "POST") {
        return json(response, 200, { status: await spotify.disconnect() });
      }

      if (pathname === "/api/twitch/test" && request.method === "POST") {
        if (!twitch) return json(response, 503, { error: "Twitch commands are unavailable." });
        const status = await twitch.restart();
        return json(response, status.connected ? 200 : 202, { status });
      }

      if (pathname === "/api/discord/test" && request.method === "POST") {
        let status = discord.status();
        if (!status.configured) {
          return json(response, 409, { error: "Save a Discord bot token first.", status });
        }
        if (!status.connected) {
          try {
            await discord.restart();
          } catch (error) {
            return json(response, 502, { error: error.message, status: discord.status() });
          }
          status = discord.status();
        }
        return json(response, status.connected ? 200 : 502, {
          status,
          error: status.connected ? null : "The Discord gateway did not become ready.",
        });
      }

      if (pathname === "/api/discord/voice-channels" && request.method === "GET") {
        if (!discord.status().connected) {
          return json(response, 409, {
            error: "Connect the Discord bot before choosing a live voice channel.",
            channels: [],
          });
        }
        return json(response, 200, {
          channels: await discord.listVoiceChannels?.(),
        });
      }

      if (pathname === "/api/discord/reactive-context" && request.method === "GET") {
        if (!discord.status().connected) {
          return json(response, 409, {
            error: "Connect the Discord bot before detecting a voice channel.",
          });
        }
        const preferredUserIds =
          session.provider === "discord" ? [session.sub] : config.discord.ownerUserIds;
        return json(
          response,
          200,
          await discord.reactiveContext?.({ preferredUserIds }),
        );
      }

      if (pathname === "/api/discord/publish-status" && request.method === "POST") {
        const message = await discord.refreshStatusPanel();
        if (!message) {
          return json(response, 409, {
            error: "Configure a Discord status channel and connect the bot first.",
            status: discord.status(),
          });
        }
        return json(response, 200, { ok: true, messageId: message.id, status: discord.status() });
      }

      if (pathname === "/api/services" && request.method === "GET") {
        return json(response, 200, { services: await services.list() });
      }

      if (pathname === "/api/services" && request.method === "POST") {
        const spec = await services.save(await readJson(request));
        await db.addAudit(session.sub, "service.saved", spec.id);
        return json(response, 201, { service: spec });
      }

      const serviceAction = pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
      if (serviceAction && request.method === "POST") {
        const status = await services.action(serviceAction[1], serviceAction[2]);
        await db.addAudit(session.sub, `service.${serviceAction[2]}`, serviceAction[1]);
        hub.broadcast("status", "service", { id: serviceAction[1], status });
        return json(response, 200, { status });
      }

      const settingMatch = pathname.match(/^\/api\/settings\/([^/]+)$/);
      if (settingMatch && SETTINGS_SCOPES.has(settingMatch[1])) {
        const key = `settings:${settingMatch[1]}`;
        if (request.method === "GET") {
          if (settingMatch[1] === "discord") {
            const secretCiphertext = await db.getOauthToken("discord-config");
            const secrets = secretCiphertext ? vault.decrypt(secretCiphertext) : {};
            return json(response, 200, {
              settings: {
                ...discordPublicSettings(await db.getSetting(key, {})),
                botTokenConfigured: Boolean(secrets.token || config.discord.token),
                clientSecretConfigured: Boolean(
                  secrets.clientSecret || config.discord.clientSecret,
                ),
              },
              status: discord.status(),
            });
          }
          if (settingMatch[1] === "spotify") {
            const secretCiphertext = await db.getOauthToken("spotify-config");
            const secrets = secretCiphertext ? vault.decrypt(secretCiphertext) : {};
            return json(response, 200, {
              settings: {
                ...spotifyPublicSettings({
                  ...config.spotify,
                  ...(await db.getSetting(key, {})),
                }),
                clientSecretConfigured: Boolean(
                  secrets.clientSecret || config.spotify?.clientSecret,
                ),
              },
              status: spotify.status(),
            });
          }
          if (settingMatch[1] === "twitch") {
            if (!twitch) return json(response, 503, { error: "Twitch commands are unavailable." });
            return json(response, 200, {
              settings: twitch.publicSettings(),
              status: twitch.status(),
            });
          }
          return json(response, 200, {
            settings: parseStored(await db.getSetting(key), {}),
          });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          if (settingMatch[1] === "discord") {
            const previousCiphertext = await db.getOauthToken("discord-config");
            const previousSecrets = previousCiphertext ? vault.decrypt(previousCiphertext) : {};
            const settings = {
              ...discordPublicSettings(await db.getSetting(key, {})),
              ...discordPublicSettings(body),
            };
            const secrets = {
              token: body.clearBotToken
                ? ""
                : String(
                    body.botToken ||
                      body.token ||
                      previousSecrets.token ||
                      config.discord.token ||
                      "",
                  ),
              clientSecret: body.clearClientSecret
                ? ""
                : String(
                    body.clientSecret ||
                      previousSecrets.clientSecret ||
                      config.discord.clientSecret ||
                      "",
                  ),
            };
            await db.setSetting(key, settings);
            if (secrets.token || secrets.clientSecret) {
              await db.saveOauthToken("discord-config", vault.encrypt(secrets));
            } else {
              await db.deleteOauthToken("discord-config");
            }
            Object.assign(config.discord, settings, secrets);
            let connectionError = null;
            try {
              if (typeof discord.restart === "function") {
                await discord.restart();
              } else {
                await discord.stop();
                await discord.reloadSettings?.();
                await discord.start();
              }
            } catch (error) {
              connectionError = error.message;
            }
            await db.addAudit(session.sub, "settings.saved", "discord");
            return json(response, 200, {
              settings: {
                ...settings,
                botTokenConfigured: Boolean(secrets.token),
                clientSecretConfigured: Boolean(secrets.clientSecret),
              },
              status: discord.status(),
              connectionError,
            });
          }
          if (settingMatch[1] === "spotify") {
            const previousSettings = spotifyPublicSettings({
              ...config.spotify,
              ...(await db.getSetting(key, {})),
            });
            const previousCiphertext = await db.getOauthToken("spotify-config");
            const previousSecrets = previousCiphertext ? vault.decrypt(previousCiphertext) : {};
            const settings = {
              ...previousSettings,
              ...spotifyPublicSettings(body),
            };
            const secrets = {
              clientSecret: body.clearClientSecret
                ? ""
                : String(
                    body.clientSecret ||
                      previousSecrets.clientSecret ||
                      config.spotify?.clientSecret ||
                      "",
                  ).trim(),
            };
            const credentialsChanged =
              settings.clientId !== previousSettings.clientId ||
              (body.clientSecret &&
                String(body.clientSecret).trim() !== previousSecrets.clientSecret);
            await db.setSetting(key, settings);
            if (secrets.clientSecret) {
              await db.saveOauthToken("spotify-config", vault.encrypt(secrets));
            } else {
              await db.deleteOauthToken("spotify-config");
            }
            if (credentialsChanged) await spotify.disconnect();
            spotify.updateCredentials({ ...settings, ...secrets });
            await db.addAudit(session.sub, "settings.saved", "spotify");
            return json(response, 200, {
              settings: {
                ...settings,
                clientSecretConfigured: Boolean(secrets.clientSecret),
              },
              status: spotify.status(),
            });
          }
          if (settingMatch[1] === "twitch") {
            if (!twitch) return json(response, 503, { error: "Twitch commands are unavailable." });
            const result = await twitch.updateSettings(body);
            await db.addAudit(session.sub, "settings.saved", "twitch");
            return json(response, 200, result);
          }
          const settings = body;
          await db.setSetting(key, settings);
          await db.addAudit(session.sub, "settings.saved", settingMatch[1]);
          if (settingMatch[1] === "discord") await discord.reloadSettings?.();
          return json(response, 200, { settings });
        }
      }

      const profilesMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (profilesMatch && PROFILE_TYPES.has(profilesMatch[1])) {
        if (request.method === "GET") {
          return json(response, 200, {
            profiles: await db.listOverlays(profilesMatch[1]),
          });
        }
        if (request.method === "POST") {
          const profile = normalizeProfile(profilesMatch[1], await readJson(request));
          await db.saveOverlay(profile);
          await db.addAudit(session.sub, "profile.created", `${profile.type}:${profile.id}`);
          let reactive = null;
          if (profile.type === "reactives" && profile.config?.voiceChannelId) {
            try {
              reactive = await discord.enableReactiveSpeaking?.({
                channelId: profile.config.voiceChannelId,
              });
            } catch (error) {
              reactive = { connected: false, error: error.message };
            }
          }
          return json(response, 201, { profile, reactive });
        }
      }

      const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/([^/]+)$/);
      if (profileMatch && PROFILE_TYPES.has(profileMatch[1])) {
        if (request.method === "PUT") {
          const profile = normalizeProfile(
            profileMatch[1],
            await readJson(request),
            profileMatch[2],
          );
          await db.saveOverlay(profile);
          await db.addAudit(session.sub, "profile.saved", `${profile.type}:${profile.id}`);
          let reactive = null;
          if (profile.type === "reactives" && profile.config?.voiceChannelId) {
            try {
              reactive = await discord.enableReactiveSpeaking?.({
                channelId: profile.config.voiceChannelId,
              });
            } catch (error) {
              reactive = { connected: false, error: error.message };
            }
          }
          hub.broadcast(`${profile.type}:${profile.id}`, "config", profile);
          return json(response, 200, { profile, reactive });
        }
        if (request.method === "DELETE") {
          await db.deleteOverlay(profileMatch[1], profileMatch[2]);
          await db.addAudit(session.sub, "profile.deleted", `${profileMatch[1]}:${profileMatch[2]}`);
          return json(response, 200, { ok: true });
        }
      }

      const overlayTest = pathname.match(/^\/api\/overlays\/([^/]+)\/test$/);
      if (overlayTest && PROFILE_TYPES.has(overlayTest[1]) && request.method === "POST") {
        const body = await readJson(request);
        const profileId = String(body.profileId || "");
        if (!profileId) return json(response, 400, { error: "profileId is required" });
        const samples = {
          alerts: {
            event: "follow",
            title: body.title || "New follower",
            message: body.message || "mintyviewer joined the stream",
          },
          reactives: {
            userId: body.userId || "preview",
            speaking: body.speaking !== false,
          },
          spotify: spotify.status(),
          chat: {
            user: "mintyviewer",
            color: "#7c8cff",
            message: "This is how chat will look on stream ✦",
          },
        };
        hub.broadcast(
          `${overlayTest[1]}:${profileId}`,
          overlayTest[1] === "alerts" ? "alert" : overlayTest[1],
          samples[overlayTest[1]] || body,
        );
        return json(response, 202, { ok: true });
      }

      const timerControl = pathname.match(/^\/api\/timer\/([^/]+)\/control$/);
      if (timerControl && request.method === "POST") {
        const state = await updateTimer({ db, hub }, timerControl[1], await readJson(request));
        return json(response, 200, { state });
      }

      if (pathname === "/api/backups" && request.method === "GET") {
        return json(response, 200, backups.status());
      }

      if (pathname === "/api/backups/run" && request.method === "POST") {
        backups.run().catch((error) => console.error("[backup]", error.message));
        await db.addAudit(session.sub, "backup.started", "dashboard");
        return json(response, 202, backups.status());
      }

      if (pathname === "/api/backups/test" && request.method === "POST") {
        return json(response, 200, await backups.test());
      }

      if (pathname.startsWith("/api/")) return json(response, 404, { error: "Not found" });

      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(response, 405, "Method not allowed");
      }

      const requestedFile =
        pathname === "/"
          ? "index.html"
          : pathname === "/overlay" || pathname.startsWith("/overlay/")
            ? "overlay.html"
            : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(webRoot, requestedFile);
      if (!filePath.startsWith(`${webRoot}${path.sep}`)) return text(response, 403, "Forbidden");
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return text(response, 404, "Not found");
      }
      const extension = path.extname(filePath);
      response.writeHead(200, {
        "content-type": MIME[extension] || "application/octet-stream",
        // Updates replace these files in place. Revalidate assets so another
        // LAN device cannot keep running an old dashboard after an update.
        "cache-control": extension === ".html" ? "no-store" : "no-cache",
      });
      if (request.method === "HEAD") return response.end();
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      console.error(`[http] ${request.method} ${pathname}:`, error);
      const status = error.statusCode || 500;
      if (pathname.startsWith("/api/")) {
        return json(response, status, {
          error: status >= 500 ? "The server could not complete that request." : error.message,
        });
      }
      return text(response, status, status >= 500 ? "The server could not complete that request." : error.message);
    }
  };

  if (Boolean(config.tlsCertFile) !== Boolean(config.tlsKeyFile)) {
    throw new Error("TLS_CERT_FILE and TLS_KEY_FILE must be configured together.");
  }
  const server =
    config.tlsCertFile && config.tlsKeyFile
      ? https.createServer(
          {
            cert: fs.readFileSync(config.tlsCertFile),
            key: fs.readFileSync(config.tlsKeyFile),
            minVersion: "TLSv1.2",
          },
          listener,
        )
      : http.createServer(listener);

  hub.attach(server);
  return server;
}

export { currentRemaining, normalizeProfile, readJson, updateTimer };
