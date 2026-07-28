import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const DEFAULT_DATABASE_NAME = "streamforge.sqlite";
const DEFAULT_AUDIT_LIMIT = 2_000;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:access_?token|refresh_?token|authorization|cookie|password|secret)(?:$|_)/i;

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS overlay_profiles (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    owner_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS overlay_profiles_type_idx
    ON overlay_profiles(type, updated_at DESC);

  CREATE TABLE IF NOT EXISTS temporary_voice_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    lobby_channel_id TEXT,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS temporary_voice_channels_owner_idx
    ON temporary_voice_channels(guild_id, owner_user_id);

  CREATE TABLE IF NOT EXISTS voice_preferences (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT,
    visibility TEXT NOT NULL DEFAULT 'public'
      CHECK (visibility IN ('public', 'locked', 'private')),
    whitelist_json TEXT NOT NULL DEFAULT '[]',
    user_limit INTEGER NOT NULL DEFAULT 0
      CHECK (user_limit BETWEEN 0 AND 99),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS service_specs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args_json TEXT NOT NULL DEFAULT '[]',
    cwd TEXT,
    env_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    autostart INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor_id TEXT,
    target TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_log_created_idx
    ON audit_log(created_at DESC);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT 'default',
    token_ciphertext TEXT NOT NULL,
    expires_at TEXT,
    scope_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider, account_id)
  );

  PRAGMA user_version = 1;
`;

function nowIso() {
  return new Date().toISOString();
}

function assertOpen(instance) {
  if (!instance._database) {
    throw new Error("Database is not initialized");
  }
}

function requiredText(value, label, maxLength = 256) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new RangeError(`${label} must be at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(value, label, maxLength = 2_048) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.length > maxLength) {
    throw new RangeError(`${label} must be at most ${maxLength} characters`);
  }
  return value;
}

function jsonStringify(value, label = "value") {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  return serialized;
}

function jsonParse(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function redactSecrets(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redactSecrets(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(item, seen),
      ]),
    );
  }
  return value;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 100);
}

function rowsFromStatement(statement) {
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  return rows;
}

export class StreamForgeDatabase {
  constructor({
    dataDir = "./data",
    databasePath,
    auditLimit = DEFAULT_AUDIT_LIMIT,
    sqlJsFactory = initSqlJs,
  } = {}) {
    this.path = resolve(databasePath ?? join(dataDir, DEFAULT_DATABASE_NAME));
    this.auditLimit = clampInteger(auditLimit, 100, 100_000, DEFAULT_AUDIT_LIMIT);
    this._sqlJsFactory = sqlJsFactory;
    this._database = null;
    this._mutationQueue = Promise.resolve();
    this._closed = false;
  }

  async init() {
    if (this._database) return this;
    if (this._closed) {
      throw new Error("Database has already been closed");
    }

    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await this._sqlJsFactory({
      locateFile: (file) =>
        file === "sql-wasm.wasm" ? wasmPath : join(dirname(wasmPath), file),
    });

    let existing;
    try {
      existing = await readFile(this.path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this._database = existing ? new SQL.Database(existing) : new SQL.Database();
    this._database.run(SCHEMA);
    await this._persist();
    return this;
  }

  async close() {
    if (this._closed) return;
    await this._mutationQueue;
    if (this._database) {
      await this._persist();
      this._database.close();
      this._database = null;
    }
    this._closed = true;
  }

  _all(sql, parameters = {}) {
    assertOpen(this);
    const statement = this._database.prepare(sql);
    try {
      statement.bind(parameters);
      return rowsFromStatement(statement);
    } finally {
      statement.free();
    }
  }

  _one(sql, parameters = {}) {
    return this._all(sql, parameters)[0] ?? null;
  }

  async _persist() {
    assertOpen(this);
    const bytes = this._database.export();
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, this.path);
  }

  _mutate(operation) {
    const result = this._mutationQueue.then(async () => {
      assertOpen(this);
      this._database.run("BEGIN IMMEDIATE");
      try {
        const value = operation();
        this._database.run("COMMIT");
        await this._persist();
        return value;
      } catch (error) {
        try {
          this._database.run("ROLLBACK");
        } catch {
          // Preserve the original error if SQLite already rolled back.
        }
        throw error;
      }
    });
    this._mutationQueue = result.catch(() => {});
    return result;
  }

  getSetting(key, fallback = null) {
    requiredText(key, "setting key");
    const row = this._one("SELECT value_json FROM settings WHERE key = $key", {
      $key: key,
    });
    return row ? jsonParse(row.value_json, fallback) : fallback;
  }

  getSettings(prefix = "") {
    if (typeof prefix !== "string") {
      throw new TypeError("setting prefix must be a string");
    }
    const rows = prefix
      ? this._all(
          `SELECT key, value_json FROM settings
           WHERE key LIKE $prefix ESCAPE '\\' ORDER BY key`,
          { $prefix: `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` },
        )
      : this._all("SELECT key, value_json FROM settings ORDER BY key");
    return Object.fromEntries(
      rows.map((row) => [row.key, jsonParse(row.value_json, null)]),
    );
  }

  setSetting(key, value) {
    requiredText(key, "setting key");
    const valueJson = jsonStringify(value, "setting value");
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ($key, $value, $updatedAt)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        { $key: key, $value: valueJson, $updatedAt: timestamp },
      );
      return value;
    });
  }

  deleteSetting(key) {
    requiredText(key, "setting key");
    return this._mutate(() => {
      this._database.run("DELETE FROM settings WHERE key = $key", { $key: key });
      return this._database.getRowsModified() > 0;
    });
  }

  listOverlays(type) {
    const rows = type
      ? this._all(
          `SELECT * FROM overlay_profiles
           WHERE type = $type ORDER BY updated_at DESC, id`,
          { $type: requiredText(type, "overlay type") },
        )
      : this._all(
          "SELECT * FROM overlay_profiles ORDER BY updated_at DESC, id",
        );
    return rows.map((row) => this._mapOverlay(row));
  }

  getOverlay(typeOrId, maybeId) {
    const id = requiredText(maybeId ?? typeOrId, "overlay id");
    const type = maybeId
      ? requiredText(typeOrId, "overlay type", 64)
      : null;
    const row = this._one(
      `SELECT * FROM overlay_profiles
       WHERE id = $id ${type ? "AND type = $type" : ""}`,
      type ? { $id: id, $type: type } : { $id: id },
    );
    return row ? this._mapOverlay(row) : null;
  }

  _mapOverlay(row) {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      config: jsonParse(row.config_json, {}),
      ownerUserId: row.owner_user_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveOverlay(profile) {
    if (!profile || typeof profile !== "object") {
      throw new TypeError("overlay profile must be an object");
    }
    const id = requiredText(profile.id, "overlay id");
    const type = requiredText(profile.type, "overlay type", 64);
    const name = requiredText(profile.name, "overlay name", 100);
    const configJson = jsonStringify(profile.config ?? {}, "overlay config");
    const ownerUserId = optionalText(
      profile.ownerUserId,
      "overlay owner user id",
      32,
    );
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO overlay_profiles
          (id, type, name, config_json, owner_user_id, created_at, updated_at)
         VALUES
          ($id, $type, $name, $config, $owner, $now, $now)
         ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          name = excluded.name,
          config_json = excluded.config_json,
          owner_user_id = excluded.owner_user_id,
          updated_at = excluded.updated_at`,
        {
          $id: id,
          $type: type,
          $name: name,
          $config: configJson,
          $owner: ownerUserId,
          $now: timestamp,
        },
      );
      return this.getOverlay(id);
    });
  }

  deleteOverlay(typeOrId, maybeId) {
    const id = requiredText(maybeId ?? typeOrId, "overlay id");
    const type = maybeId
      ? requiredText(typeOrId, "overlay type", 64)
      : null;
    return this._mutate(() => {
      this._database.run(
        `DELETE FROM overlay_profiles
         WHERE id = $id ${type ? "AND type = $type" : ""}`,
        type ? { $id: id, $type: type } : { $id: id },
      );
      return this._database.getRowsModified() > 0;
    });
  }

  listServices({ includeDisabled = true } = {}) {
    const rows = this._all(
      `SELECT * FROM service_specs
       ${includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY name COLLATE NOCASE, id`,
    );
    return rows.map((row) => this._mapService(row));
  }

  getService(id) {
    requiredText(id, "service id");
    const row = this._one("SELECT * FROM service_specs WHERE id = $id", {
      $id: id,
    });
    return row ? this._mapService(row) : null;
  }

  _mapService(row) {
    return {
      id: row.id,
      name: row.name,
      command: row.command,
      args: jsonParse(row.args_json, []),
      cwd: row.cwd ?? null,
      env: jsonParse(row.env_json, {}),
      enabled: Boolean(row.enabled),
      autostart: Boolean(row.autostart),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveService(service) {
    if (!service || typeof service !== "object") {
      throw new TypeError("service spec must be an object");
    }
    const id = requiredText(service.id, "service id", 64);
    const name = requiredText(service.name ?? service.id, "service name", 100);
    const command = requiredText(service.command, "service command", 2_048);
    const args = Array.isArray(service.args)
      ? service.args.map((arg) => String(arg))
      : [];
    const env =
      service.env && typeof service.env === "object" && !Array.isArray(service.env)
        ? service.env
        : {};
    const cwd = optionalText(service.cwd, "service cwd", 2_048);
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO service_specs
          (id, name, command, args_json, cwd, env_json, enabled, autostart,
           created_at, updated_at)
         VALUES
          ($id, $name, $command, $args, $cwd, $env, $enabled, $autostart,
           $now, $now)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          command = excluded.command,
          args_json = excluded.args_json,
          cwd = excluded.cwd,
          env_json = excluded.env_json,
          enabled = excluded.enabled,
          autostart = excluded.autostart,
          updated_at = excluded.updated_at`,
        {
          $id: id,
          $name: name,
          $command: command,
          $args: jsonStringify(args, "service args"),
          $cwd: cwd,
          $env: jsonStringify(env, "service env"),
          $enabled: service.enabled === false ? 0 : 1,
          $autostart: service.autostart ? 1 : 0,
          $now: timestamp,
        },
      );
      return this.getService(id);
    });
  }

  deleteService(id) {
    requiredText(id, "service id");
    return this._mutate(() => {
      this._database.run("DELETE FROM service_specs WHERE id = $id", {
        $id: id,
      });
      return this._database.getRowsModified() > 0;
    });
  }

  getOauthTokenRecord(provider, accountId = "default") {
    requiredText(provider, "OAuth provider", 64);
    requiredText(accountId, "OAuth account id", 128);
    const row = this._one(
      `SELECT provider, account_id, token_ciphertext, expires_at, scope_json,
              updated_at
       FROM oauth_tokens
       WHERE provider = $provider AND account_id = $account`,
      { $provider: provider, $account: accountId },
    );
    if (!row) return null;
    return {
      provider: row.provider,
      accountId: row.account_id,
      encryptedToken: row.token_ciphertext,
      expiresAt: row.expires_at ?? null,
      scopes: jsonParse(row.scope_json, []),
      updatedAt: row.updated_at,
    };
  }

  getOauthToken(provider, accountId = "default") {
    return this.getOauthTokenRecord(provider, accountId)?.encryptedToken ?? null;
  }

  saveOauthToken(tokenOrProvider, encryptedTokenValue) {
    const token =
      typeof tokenOrProvider === "string"
        ? {
            provider: tokenOrProvider,
            encryptedToken: encryptedTokenValue,
          }
        : tokenOrProvider;
    if (!token || typeof token !== "object") {
      throw new TypeError("OAuth token record must be an object");
    }
    const provider = requiredText(token.provider, "OAuth provider", 64);
    const accountId = requiredText(
      token.accountId ?? "default",
      "OAuth account id",
      128,
    );
    const encryptedToken = requiredText(
      token.encryptedToken ?? token.tokenCiphertext,
      "encrypted OAuth token",
      100_000,
    );
    const expiresAt = optionalText(token.expiresAt, "OAuth expiry", 64);
    const scopes = normalizeIdList(token.scopes);
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO oauth_tokens
          (provider, account_id, token_ciphertext, expires_at, scope_json,
           updated_at)
         VALUES ($provider, $account, $token, $expires, $scopes, $now)
         ON CONFLICT(provider, account_id) DO UPDATE SET
          token_ciphertext = excluded.token_ciphertext,
          expires_at = excluded.expires_at,
          scope_json = excluded.scope_json,
          updated_at = excluded.updated_at`,
        {
          $provider: provider,
          $account: accountId,
          $token: encryptedToken,
          $expires: expiresAt,
          $scopes: jsonStringify(scopes),
          $now: timestamp,
        },
      );
      return this.getOauthTokenRecord(provider, accountId);
    });
  }

  deleteOauthToken(provider, accountId = "default") {
    requiredText(provider, "OAuth provider", 64);
    requiredText(accountId, "OAuth account id", 128);
    return this._mutate(() => {
      this._database.run(
        `DELETE FROM oauth_tokens
         WHERE provider = $provider AND account_id = $account`,
        { $provider: provider, $account: accountId },
      );
      return this._database.getRowsModified() > 0;
    });
  }

  addAudit(entryOrActor, actionValue, targetValue, detailsValue) {
    const entry =
      typeof entryOrActor === "object" && entryOrActor !== null
        ? entryOrActor
        : {
            actorId: entryOrActor,
            action: actionValue,
            target: targetValue,
            details: detailsValue,
          };
    if (!entry || typeof entry !== "object") {
      throw new TypeError("audit entry must be an object");
    }
    const action = requiredText(entry.action, "audit action", 128);
    const actorId = optionalText(
      entry.actorId ?? entry.actor,
      "audit actor id",
      128,
    );
    const target = optionalText(entry.target, "audit target", 512);
    const detailsJson = jsonStringify(
      redactSecrets(entry.details ?? {}),
      "audit details",
    );
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO audit_log
          (action, actor_id, target, details_json, created_at)
         VALUES ($action, $actor, $target, $details, $now)`,
        {
          $action: action,
          $actor: actorId,
          $target: target,
          $details: detailsJson,
          $now: timestamp,
        },
      );
      const id = Number(
        this._one("SELECT last_insert_rowid() AS id")?.id ?? 0,
      );
      this._database.run(
        `DELETE FROM audit_log
         WHERE id NOT IN (
           SELECT id FROM audit_log ORDER BY id DESC LIMIT $limit
         )`,
        { $limit: this.auditLimit },
      );
      return {
        id,
        action,
        actorId,
        target,
        details: jsonParse(detailsJson, {}),
        createdAt: timestamp,
      };
    });
  }

  listAudit({ limit = 100, offset = 0, action, actorId } = {}) {
    const safeLimit = clampInteger(limit, 1, 500, 100);
    const safeOffset = clampInteger(offset, 0, 1_000_000, 0);
    const filters = [];
    const parameters = { $limit: safeLimit, $offset: safeOffset };
    if (action) {
      filters.push("action = $action");
      parameters.$action = requiredText(action, "audit action", 128);
    }
    if (actorId) {
      filters.push("actor_id = $actor");
      parameters.$actor = requiredText(actorId, "audit actor id", 128);
    }
    const rows = this._all(
      `SELECT * FROM audit_log
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT $limit OFFSET $offset`,
      parameters,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      actorId: row.actor_id ?? null,
      target: row.target ?? null,
      details: jsonParse(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  listTempChannels(guildId) {
    const rows = guildId
      ? this._all(
          `SELECT * FROM temporary_voice_channels
           WHERE guild_id = $guild ORDER BY created_at`,
          { $guild: requiredText(guildId, "guild id", 32) },
        )
      : this._all(
          "SELECT * FROM temporary_voice_channels ORDER BY created_at",
        );
    return rows.map((row) => this._mapTempChannel(row));
  }

  getTempChannel(channelId) {
    requiredText(channelId, "channel id", 32);
    const row = this._one(
      "SELECT * FROM temporary_voice_channels WHERE channel_id = $channel",
      { $channel: channelId },
    );
    return row ? this._mapTempChannel(row) : null;
  }

  _mapTempChannel(row) {
    return {
      channelId: row.channel_id,
      guildId: row.guild_id,
      ownerUserId: row.owner_user_id,
      lobbyChannelId: row.lobby_channel_id ?? null,
      config: jsonParse(row.config_json, {}),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  saveTempChannel(channel) {
    if (!channel || typeof channel !== "object") {
      throw new TypeError("temporary voice channel must be an object");
    }
    const channelId = requiredText(channel.channelId, "channel id", 32);
    const guildId = requiredText(channel.guildId, "guild id", 32);
    const ownerUserId = requiredText(
      channel.ownerUserId,
      "channel owner user id",
      32,
    );
    const lobbyChannelId = optionalText(
      channel.lobbyChannelId,
      "lobby channel id",
      32,
    );
    const configJson = jsonStringify(channel.config ?? {}, "channel config");
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO temporary_voice_channels
          (channel_id, guild_id, owner_user_id, lobby_channel_id, config_json,
           created_at, last_active_at)
         VALUES ($channel, $guild, $owner, $lobby, $config, $now, $now)
         ON CONFLICT(channel_id) DO UPDATE SET
          guild_id = excluded.guild_id,
          owner_user_id = excluded.owner_user_id,
          lobby_channel_id = excluded.lobby_channel_id,
          config_json = excluded.config_json,
          last_active_at = excluded.last_active_at`,
        {
          $channel: channelId,
          $guild: guildId,
          $owner: ownerUserId,
          $lobby: lobbyChannelId,
          $config: configJson,
          $now: timestamp,
        },
      );
      return this.getTempChannel(channelId);
    });
  }

  touchTempChannel(channelId) {
    requiredText(channelId, "channel id", 32);
    return this._mutate(() => {
      this._database.run(
        `UPDATE temporary_voice_channels
         SET last_active_at = $now WHERE channel_id = $channel`,
        { $channel: channelId, $now: nowIso() },
      );
      return this._database.getRowsModified() > 0;
    });
  }

  deleteTempChannel(channelId) {
    requiredText(channelId, "channel id", 32);
    return this._mutate(() => {
      this._database.run(
        "DELETE FROM temporary_voice_channels WHERE channel_id = $channel",
        { $channel: channelId },
      );
      return this._database.getRowsModified() > 0;
    });
  }

  getVoicePreferences(guildId, userId) {
    requiredText(guildId, "guild id", 32);
    requiredText(userId, "user id", 32);
    const row = this._one(
      `SELECT * FROM voice_preferences
       WHERE guild_id = $guild AND user_id = $user`,
      { $guild: guildId, $user: userId },
    );
    if (!row) {
      return {
        guildId,
        userId,
        name: null,
        visibility: "public",
        whitelist: [],
        userLimit: 0,
        updatedAt: null,
      };
    }
    return {
      guildId: row.guild_id,
      userId: row.user_id,
      name: row.name ?? null,
      visibility: row.visibility,
      whitelist: jsonParse(row.whitelist_json, []),
      userLimit: Number(row.user_limit),
      updatedAt: row.updated_at,
    };
  }

  saveVoicePreferences(preferences) {
    if (!preferences || typeof preferences !== "object") {
      throw new TypeError("voice preferences must be an object");
    }
    const guildId = requiredText(preferences.guildId, "guild id", 32);
    const userId = requiredText(preferences.userId, "user id", 32);
    const name = optionalText(preferences.name, "voice channel name", 100);
    const visibility = ["public", "locked", "private"].includes(
      preferences.visibility,
    )
      ? preferences.visibility
      : "public";
    const whitelist = normalizeIdList(
      preferences.whitelist ?? preferences.whitelistUserIds,
    ).filter((id) => id !== userId);
    const userLimit = clampInteger(preferences.userLimit, 0, 99, 0);
    const timestamp = nowIso();
    return this._mutate(() => {
      this._database.run(
        `INSERT INTO voice_preferences
          (guild_id, user_id, name, visibility, whitelist_json, user_limit,
           updated_at)
         VALUES ($guild, $user, $name, $visibility, $whitelist, $limit, $now)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
          name = excluded.name,
          visibility = excluded.visibility,
          whitelist_json = excluded.whitelist_json,
          user_limit = excluded.user_limit,
          updated_at = excluded.updated_at`,
        {
          $guild: guildId,
          $user: userId,
          $name: name,
          $visibility: visibility,
          $whitelist: jsonStringify(whitelist),
          $limit: userLimit,
          $now: timestamp,
        },
      );
      return this.getVoicePreferences(guildId, userId);
    });
  }

  deleteVoicePreferences(guildId, userId) {
    requiredText(guildId, "guild id", 32);
    requiredText(userId, "user id", 32);
    return this._mutate(() => {
      this._database.run(
        `DELETE FROM voice_preferences
         WHERE guild_id = $guild AND user_id = $user`,
        { $guild: guildId, $user: userId },
      );
      return this._database.getRowsModified() > 0;
    });
  }

  // Explicit aliases keep the public API readable for both the bot and HTTP API.
  listTemporaryVoiceChannels(guildId) {
    return this.listTempChannels(guildId);
  }

  getTemporaryVoiceChannel(channelId) {
    return this.getTempChannel(channelId);
  }

  saveTemporaryVoiceChannel(channel) {
    return this.saveTempChannel(channel);
  }

  deleteTemporaryVoiceChannel(channelId) {
    return this.deleteTempChannel(channelId);
  }

  getVoicePrefs(guildId, userId) {
    return this.getVoicePreferences(guildId, userId);
  }

  saveVoicePrefs(preferences) {
    return this.saveVoicePreferences(preferences);
  }
}

export async function createDatabase(options) {
  const database = new StreamForgeDatabase(options);
  await database.init();
  return database;
}

export default createDatabase;
