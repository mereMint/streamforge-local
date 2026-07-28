import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

const STATUS_SETTING_PREFIX = "discord.statusMessageId";
const MAX_STATUS_SERVICES = 20;
const DEFAULT_STATUS_INTERVAL_SECONDS = 60;
const DEFAULT_DELETE_DELAY_MS = 1_500;

function list(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function normalizeDiscordConfig(config = {}) {
  const discord = config.discord ?? {};
  return {
    token: firstDefined(
      config.token,
      config.discordToken,
      config.DISCORD_TOKEN,
      discord.token,
      "",
    ),
    clientId: firstDefined(
      config.clientId,
      config.discordClientId,
      config.DISCORD_CLIENT_ID,
      discord.clientId,
      "",
    ),
    guildId: firstDefined(
      config.guildId,
      config.discordGuildId,
      config.DISCORD_GUILD_ID,
      discord.guildId,
      "",
    ),
    adminRoleIds: list(
      firstDefined(
        config.adminRoleIds,
        config.discordAdminRoleIds,
        config.DISCORD_ADMIN_ROLE_IDS,
        discord.adminRoleIds,
      ),
    ),
    ownerUserIds: list(
      firstDefined(
        config.ownerUserIds,
        config.discordOwnerUserIds,
        config.DISCORD_OWNER_USER_IDS,
        discord.ownerUserIds,
      ),
    ),
    autoRoleId: firstDefined(
      config.autoRoleId,
      config.discordAutoRoleId,
      config.DISCORD_AUTO_ROLE_ID,
      discord.autoRoleId,
      "",
    ),
    statusChannelId: firstDefined(
      config.statusChannelId,
      config.discordStatusChannelId,
      config.DISCORD_STATUS_CHANNEL_ID,
      discord.statusChannelId,
      "",
    ),
    tempVoiceLobbyId: firstDefined(
      config.tempVoiceLobbyId,
      config.discordTempVoiceLobbyId,
      config.DISCORD_TEMP_VOICE_LOBBY_ID,
      discord.tempVoiceLobbyId,
      "",
    ),
    tempVoiceCategoryId: firstDefined(
      config.tempVoiceCategoryId,
      config.discordTempVoiceCategoryId,
      config.DISCORD_TEMP_VOICE_CATEGORY_ID,
      discord.tempVoiceCategoryId,
      "",
    ),
    reactiveVoiceChannelId: firstDefined(
      config.reactiveVoiceChannelId,
      config.discordReactiveVoiceChannelId,
      config.DISCORD_REACTIVE_VOICE_CHANNEL_ID,
      discord.reactiveVoiceChannelId,
      "",
    ),
    statusUpdateSeconds: integer(
      firstDefined(
        config.statusUpdateSeconds,
        config.STATUS_UPDATE_SECONDS,
        discord.statusUpdateSeconds,
      ),
      DEFAULT_STATUS_INTERVAL_SECONDS,
      15,
      3_600,
    ),
    tempVoiceDeleteDelayMs: integer(
      firstDefined(
        config.tempVoiceDeleteDelayMs,
        discord.tempVoiceDeleteDelayMs,
      ),
      DEFAULT_DELETE_DELAY_MS,
      0,
      30_000,
    ),
  };
}

export function discordGatewayIntents(config = {}) {
  const settings = normalizeDiscordConfig(config);
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ];
  if (settings.autoRoleId) intents.push(GatewayIntentBits.GuildMembers);
  return intents;
}

export function discordConnectionDiagnostic(error, config = {}) {
  const message = String(error?.message || error || "").trim();
  if (/disallowed intents/i.test(message)) {
    return {
      code: "disallowed-intents",
      message: normalizeDiscordConfig(config).autoRoleId
        ? "Discord rejected the Server Members Intent. Enable it in the Developer Portal or disable automatic member roles."
        : "Discord rejected a gateway intent that is not needed by the current configuration. Restart with the updated intent selection.",
    };
  }
  if (/invalid token|token was invalid|incorrect login/i.test(message)) {
    return {
      code: "invalid-token",
      message: "Discord rejected the bot token. Save a current bot token and reconnect.",
    };
  }
  if (!message) return null;
  return { code: "connection-error", message };
}

export function sanitizeVoiceChannelName(value, fallback = "Personal room") {
  const sanitized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return sanitized || fallback;
}

export function normalizeVoicePreferences(preferences = {}, fallbackName) {
  const visibility = ["public", "locked", "private"].includes(
    preferences.visibility,
  )
    ? preferences.visibility
    : "public";
  const whitelist = [
    ...new Set(
      list(preferences.whitelist ?? preferences.whitelistUserIds).filter((id) =>
        /^\d{5,32}$/.test(id),
      ),
    ),
  ].slice(0, 100);
  return {
    name: sanitizeVoiceChannelName(preferences.name, fallbackName),
    visibility,
    whitelist,
    userLimit: integer(preferences.userLimit, 0, 0, 99),
  };
}

export function buildVoicePermissionOverwrites({
  everyoneRoleId,
  ownerUserId,
  visibility = "public",
  whitelist = [],
}) {
  const overwrites = [
    {
      id: ownerUserId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (visibility === "locked") {
    overwrites.unshift({
      id: everyoneRoleId,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.Connect],
    });
  } else if (visibility === "private") {
    overwrites.unshift({
      id: everyoneRoleId,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    });
  }

  if (visibility !== "public") {
    for (const userId of new Set(whitelist)) {
      if (userId === ownerUserId || userId === everyoneRoleId) continue;
      overwrites.push({
        id: userId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      });
    }
  }

  return overwrites;
}

export function isDiscordAdmin(interaction, config = {}) {
  const normalized = normalizeDiscordConfig(config);
  const userId = interaction?.user?.id ?? interaction?.member?.user?.id;
  if (userId && normalized.ownerUserIds.includes(userId)) return true;

  if (interaction?.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roles = interaction?.member?.roles;
  const roleIds = Array.isArray(roles)
    ? roles
    : roles?.cache
      ? [...roles.cache.keys()]
      : Array.isArray(roles?._roles)
        ? roles._roles
        : [];
  return roleIds.some((roleId) => normalized.adminRoleIds.includes(roleId));
}

function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show the StreamForge server and service status")
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("service")
      .setDescription("Control an allowlisted StreamForge service")
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Action to perform")
          .setRequired(true)
          .addChoices(
            { name: "Start", value: "start" },
            { name: "Stop", value: "stop" },
            { name: "Restart", value: "restart" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("service")
          .setDescription("Exact ID of a service configured in StreamForge")
          .setRequired(true)
          .setMaxLength(64),
      ),
    new SlashCommandBuilder()
      .setName("voice-settings")
      .setDescription("Save settings for your temporary voice channel")
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Channel name")
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName("visibility")
          .setDescription("Who can see and join")
          .addChoices(
            { name: "Public", value: "public" },
            {
              name: "Visible, whitelist can join",
              value: "locked",
            },
            {
              name: "Only visible to whitelist",
              value: "private",
            },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("whitelist")
          .setDescription("User mentions or Discord user IDs, separated by spaces")
          .setMaxLength(1_000),
      )
      .addIntegerOption((option) =>
        option
          .setName("user-limit")
          .setDescription("0 for unlimited")
          .setMinValue(0)
          .setMaxValue(99),
      ),
  ].map((command) => command.toJSON());
}

function log(logger, level, message, error) {
  const writer = logger?.[level] ?? logger?.log;
  if (typeof writer !== "function") return;
  if (error) {
    writer.call(logger, message, { error: error.message });
  } else {
    writer.call(logger, message);
  }
}

function sendBroadcast(broadcast, type, data) {
  if (typeof broadcast !== "function") return;
  try {
    if (broadcast.length >= 2) {
      broadcast("discord", type, data);
    } else {
      broadcast({ topic: "discord", type, data });
    }
  } catch {
    // A disconnected dashboard must not interrupt Discord event handling.
  }
}

function serviceStateLabel(service) {
  const status = service?.status;
  if (status && typeof status === "object") {
    return String(
      status.state ?? (status.running ? "running" : "stopped"),
    );
  }
  return String(
    status ?? service?.state ?? (service?.running ? "running" : "stopped"),
  );
}

function serviceName(service) {
  return String(service?.name ?? service?.id ?? "service").slice(0, 100);
}

function extractServices(status) {
  if (Array.isArray(status)) return status;
  if (Array.isArray(status?.services)) return status.services;
  if (status?.services && typeof status.services === "object") {
    return Object.entries(status.services).map(([id, value]) => ({
      id,
      ...(typeof value === "object" ? value : { status: value }),
    }));
  }
  return [];
}

function buildStatusEmbed(status, botStatus) {
  const services = extractServices(status).slice(0, MAX_STATUS_SERVICES);
  const running = services.filter(
    (service) => serviceStateLabel(service).toLowerCase() === "running",
  ).length;
  const description = services.length
    ? services
        .map(
          (service) =>
            `• **${serviceName(service)}:** ${serviceStateLabel(service).slice(0, 80)}`,
        )
        .join("\n")
    : "No services are configured.";

  return new EmbedBuilder()
    .setTitle("StreamForge Local")
    .setColor(running === services.length ? 0x2ecc71 : 0xf1c40f)
    .setDescription(description)
    .addFields(
      {
        name: "Server",
        value: String(
          status?.status ??
            status?.state ??
            (status?.ok === false ? "degraded" : "online"),
        ).slice(0, 100),
        inline: true,
      },
      {
        name: "Services",
        value: `${running}/${services.length} running`,
        inline: true,
      },
      {
        name: "Discord",
        value: botStatus.ready ? "connected" : "starting",
        inline: true,
      },
    )
    .setFooter({ text: "Updates automatically" })
    .setTimestamp();
}

function parseWhitelist(value) {
  return [
    ...new Set(
      String(value ?? "")
        .match(/\d{5,32}/g)
        ?.filter(Boolean) ?? [],
    ),
  ].slice(0, 100);
}

async function interactionReply(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(payload);
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

export function createDiscordBot({
  config = {},
  db,
  serviceManager,
  broadcast,
  getStatus: getApplicationStatus,
  logger = console,
  client: suppliedClient,
} = {}) {
  if (!db) throw new TypeError("createDiscordBot requires a database");

  let settings = normalizeDiscordConfig(config);
  let client = suppliedClient ?? null;
  const ownsClient = !suppliedClient;
  let started = false;
  let statusTimer = null;
  let voiceConnection = null;
  let reactiveChannelId = null;
  let reactiveCallbacks = null;
  let lastConnectionError = null;
  const deleteTimers = new Map();
  const creationLocks = new Map();

  function ensureClient() {
    if (client) return client;
    client = new Client({
      intents: discordGatewayIntents({ discord: settings }),
    });
    attachEvents();
    return client;
  }

  function botStatus() {
    const guild = settings.guildId ? client?.guilds?.cache?.get?.(settings.guildId) : null;
    return {
      configured: Boolean(settings.token),
      connected: Boolean(client?.isReady?.()),
      enabled: Boolean(settings.token),
      started,
      ready: Boolean(client?.isReady?.()),
      userId: client?.user?.id ?? null,
      username: client?.user?.tag ?? client?.user?.username ?? null,
      guildId: settings.guildId || null,
      guildName: guild?.name ?? null,
      pingMs: Number.isFinite(client?.ws?.ping) ? Math.round(client.ws.ping) : null,
      connectionError: lastConnectionError,
      connectionDiagnostic: discordConnectionDiagnostic(
        lastConnectionError,
        { discord: settings },
      ),
      requiresServerMembersIntent: Boolean(settings.autoRoleId),
      reactiveSpeaking: Boolean(voiceConnection),
      reactiveVoiceChannelId: reactiveChannelId,
      temporaryVoiceChannels: settings.guildId
        ? db.listTempChannels(settings.guildId).length
        : 0,
    };
  }

  function reactiveMember(member, voiceState = member?.voice) {
    const user = member?.user;
    if (!member || user?.bot) return null;
    return {
      userId: String(member.id || user?.id || ""),
      displayName:
        member.displayName || user?.globalName || user?.displayName || user?.username || "Speaker",
      username: user?.username || null,
      avatarUrl:
        member.displayAvatarURL?.({ extension: "png", size: 256 }) ||
        user?.displayAvatarURL?.({ extension: "png", size: 256 }) ||
        user?.avatarURL?.({ extension: "png", size: 256 }) ||
        null,
      channelId: voiceState?.channelId || member.voice?.channelId || null,
      selfMuted: Boolean(voiceState?.selfMute),
      serverMuted: Boolean(voiceState?.serverMute),
      selfDeafened: Boolean(voiceState?.selfDeaf),
      serverDeafened: Boolean(voiceState?.serverDeaf),
      suppressed: Boolean(voiceState?.suppress),
    };
  }

  function channelSnapshot(channel) {
    return {
      channelId: channel?.id || null,
      channelName: channel?.name || null,
      members: [...(channel?.members?.values?.() || [])]
        .map((member) => reactiveMember(member))
        .filter(Boolean),
      updatedAt: new Date().toISOString(),
    };
  }

  function publishReactiveSnapshot(channel) {
    if (!channel) return null;
    const snapshot = channelSnapshot(channel);
    sendBroadcast(broadcast, "discord.voice.snapshot", snapshot);
    return snapshot;
  }

  async function listVoiceChannels() {
    if (!client?.isReady?.()) return [];
    const guild =
      client.guilds.cache.get(settings.guildId) ??
      (await client.guilds.fetch(settings.guildId).catch(() => null));
    if (!guild) return [];
    const channels = guild.channels.cache?.values
      ? [...guild.channels.cache.values()]
      : [...(await guild.channels.fetch()).values()];
    return channels
      .filter((channel) => channel?.isVoiceBased?.())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        memberCount: channel.members?.size || 0,
        members: [...(channel.members?.values?.() || [])]
          .map((member) => reactiveMember(member))
          .filter(Boolean),
      }))
      .sort((left, right) => right.memberCount - left.memberCount || left.name.localeCompare(right.name));
  }

  async function reactiveContext({ preferredUserIds = [] } = {}) {
    const channels = await listVoiceChannels();
    const preferred = new Set(
      [...preferredUserIds, ...settings.ownerUserIds].map(String).filter(Boolean),
    );
    const selected =
      channels.find((channel) =>
        channel.members.some((member) => preferred.has(member.userId)),
      ) ||
      channels.find((channel) => channel.id === reactiveChannelId) ||
      channels.find((channel) => channel.memberCount > 0) ||
      null;
    return { selectedChannelId: selected?.id || null, channels };
  }

  async function currentApplicationStatus() {
    if (typeof getApplicationStatus === "function") {
      return (await getApplicationStatus()) ?? {};
    }
    if (typeof serviceManager?.getStatus === "function") {
      return (await serviceManager.getStatus()) ?? {};
    }
    if (typeof serviceManager?.listStatuses === "function") {
      return { services: (await serviceManager.listStatuses()) ?? [] };
    }
    if (typeof serviceManager?.list === "function") {
      return { services: (await serviceManager.list()) ?? [] };
    }
    return { services: [] };
  }

  async function registerCommands() {
    if (!client?.application) {
      throw new Error("Discord client is not ready");
    }
    const commands = commandDefinitions();
    if (settings.guildId) {
      const guild =
        client.guilds.cache.get(settings.guildId) ??
        (await client.guilds.fetch(settings.guildId));
      await guild.commands.set(commands);
    } else {
      await client.application.commands.set(commands);
    }
    return commands;
  }

  async function refreshStatusPanel() {
    if (!settings.statusChannelId || !client?.isReady?.()) return null;
    const channel = await client.channels.fetch(settings.statusChannelId);
    if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
      throw new Error("Discord status channel is not a text channel");
    }

    const embed = buildStatusEmbed(await currentApplicationStatus(), botStatus());
    const settingKey = `${STATUS_SETTING_PREFIX}:${settings.guildId || "global"}`;
    const previousId = db.getSetting(settingKey, null);
    let message = null;
    if (previousId && channel.messages?.fetch) {
      try {
        message = await channel.messages.fetch(previousId);
      } catch {
        // Missing/removed status messages are recreated below.
      }
    }
    if (message?.edit) {
      await message.edit({ embeds: [embed] });
    } else {
      message = await channel.send({ embeds: [embed] });
      await db.setSetting(settingKey, message.id);
    }
    return message;
  }

  async function serviceAction(action, serviceId, actorId) {
    if (!["start", "stop", "restart"].includes(action)) {
      throw new Error("Unsupported service action");
    }
    const spec =
      db.getService?.(serviceId) ??
      (typeof serviceManager?.getService === "function"
        ? await serviceManager.getService(serviceId)
        : null);
    if (!spec || spec.enabled === false) {
      throw new Error("Unknown or disabled service");
    }

    const method =
      serviceManager?.[action] ?? serviceManager?.[`${action}Service`];
    if (typeof method !== "function") {
      throw new Error("Service control is unavailable");
    }
    // Only the saved service ID is passed. Discord input is never executed.
    const result = await method.call(serviceManager, spec.id);
    await db.addAudit({
      action: `service.${action}`,
      actorId,
      target: spec.id,
      details: { source: "discord" },
    });
    sendBroadcast(broadcast, "services.changed", {
      serviceId: spec.id,
      action,
    });
    void refreshStatusPanel().catch((error) =>
      log(logger, "warn", "Discord status update failed", error),
    );
    return result;
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return;
    if (
      settings.guildId &&
      interaction.guildId &&
      interaction.guildId !== settings.guildId
    ) {
      await interactionReply(interaction, {
        content: "This bot is not configured for this server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "voice-settings") {
      const current = db.getVoicePreferences(
        interaction.guildId,
        interaction.user.id,
      );
      const whitelistInput = interaction.options.getString("whitelist");
      const preferences = await db.saveVoicePreferences({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        name: interaction.options.getString("name") ?? current.name,
        visibility:
          interaction.options.getString("visibility") ?? current.visibility,
        whitelist:
          whitelistInput === null
            ? current.whitelist
            : parseWhitelist(whitelistInput),
        userLimit:
          interaction.options.getInteger("user-limit") ?? current.userLimit,
      });
      await updateTempChannelPreferences(
        interaction.guildId,
        interaction.user.id,
      );
      await db.addAudit({
        action: "voice.preferences.updated",
        actorId: interaction.user.id,
        target: interaction.guildId,
        details: {
          visibility: preferences.visibility,
          userLimit: preferences.userLimit,
          whitelistCount: preferences.whitelist.length,
        },
      });
      await interactionReply(interaction, {
        content: "Your temporary voice-channel settings were saved.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!isDiscordAdmin(interaction, settings)) {
      await interactionReply(interaction, {
        content: "You do not have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "status") {
      const embed = buildStatusEmbed(
        await currentApplicationStatus(),
        botStatus(),
      );
      await interactionReply(interaction, {
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "service") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const action = interaction.options.getString("action", true);
      const serviceId = interaction.options.getString("service", true);
      try {
        await serviceAction(action, serviceId, interaction.user.id);
        await interaction.editReply(
          `${action[0].toUpperCase()}${action.slice(1)} completed for \`${serviceId}\`.`,
        );
      } catch (error) {
        log(logger, "warn", "Discord service action failed", error);
        await interaction.editReply(`Service action failed: ${error.message}`);
      }
    }
  }

  async function addAutoRole(member) {
    if (!settings.autoRoleId || member.user?.bot) return;
    if (settings.guildId && member.guild.id !== settings.guildId) return;
    try {
      await member.roles.add(
        settings.autoRoleId,
        "StreamForge automatic member role",
      );
      await db.addAudit({
        action: "discord.auto_role.added",
        actorId: client?.user?.id ?? "discord-bot",
        target: member.id,
        details: { roleId: settings.autoRoleId },
      });
    } catch (error) {
      log(logger, "warn", "Could not add Discord auto-role", error);
    }
  }

  async function findOrCreateTemporaryChannel(voiceState) {
    const guild = voiceState.guild;
    const member = voiceState.member;
    const lockKey = `${guild.id}:${member.id}`;
    if (creationLocks.has(lockKey)) return creationLocks.get(lockKey);

    const promise = (async () => {
      const previous = db
        .listTempChannels(guild.id)
        .find((record) => record.ownerUserId === member.id);
      if (previous) {
        const existing =
          guild.channels.cache.get(previous.channelId) ??
          (await guild.channels.fetch(previous.channelId).catch(() => null));
        if (existing?.isVoiceBased?.()) {
          await voiceState.setChannel(existing);
          return existing;
        }
        await db.deleteTempChannel(previous.channelId);
      }

      const stored = db.getVoicePreferences(guild.id, member.id);
      const preferences = normalizeVoicePreferences(
        stored,
        `${member.displayName ?? member.user.username}'s room`,
      );
      const channel = await guild.channels.create({
        name: preferences.name,
        type: ChannelType.GuildVoice,
        parent: settings.tempVoiceCategoryId || voiceState.channel?.parentId,
        userLimit: preferences.userLimit,
        permissionOverwrites: buildVoicePermissionOverwrites({
          everyoneRoleId: guild.roles.everyone.id,
          ownerUserId: member.id,
          visibility: preferences.visibility,
          whitelist: preferences.whitelist,
        }),
        reason: `Temporary voice channel for ${member.user.tag ?? member.id}`,
      });

      try {
        await db.saveTempChannel({
          channelId: channel.id,
          guildId: guild.id,
          ownerUserId: member.id,
          lobbyChannelId: settings.tempVoiceLobbyId,
          config: preferences,
        });
        await voiceState.setChannel(channel);
      } catch (error) {
        await channel
          .delete("Temporary voice-channel setup failed")
          .catch(() => {});
        await db.deleteTempChannel(channel.id).catch(() => {});
        throw error;
      }

      await db.addAudit({
        action: "voice.channel.created",
        actorId: member.id,
        target: channel.id,
        details: {
          visibility: preferences.visibility,
          userLimit: preferences.userLimit,
        },
      });
      sendBroadcast(broadcast, "discord.voice.created", {
        channelId: channel.id,
        ownerUserId: member.id,
      });
      return channel;
    })().finally(() => creationLocks.delete(lockKey));

    creationLocks.set(lockKey, promise);
    return promise;
  }

  async function deleteTemporaryChannelIfEmpty(channelId, guild) {
    const record = db.getTempChannel(channelId);
    if (!record) return false;
    const channel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null));
    if (channel?.members?.size) {
      await db.touchTempChannel(channelId);
      return false;
    }
    if (channel?.delete) {
      await channel.delete("Temporary voice channel is empty");
    }
    await db.deleteTempChannel(channelId);
    await db.addAudit({
      action: "voice.channel.deleted",
      actorId: client?.user?.id ?? "discord-bot",
      target: channelId,
      details: { reason: "empty" },
    });
    sendBroadcast(broadcast, "discord.voice.deleted", { channelId });
    return true;
  }

  function scheduleTemporaryChannelDeletion(channelId, guild) {
    if (!db.getTempChannel(channelId)) return;
    const previous = deleteTimers.get(channelId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      deleteTimers.delete(channelId);
      void deleteTemporaryChannelIfEmpty(channelId, guild).catch((error) =>
        log(logger, "warn", "Temporary voice-channel cleanup failed", error),
      );
    }, settings.tempVoiceDeleteDelayMs);
    timer.unref?.();
    deleteTimers.set(channelId, timer);
  }

  async function handleVoiceState(oldState, newState) {
    if (newState.member?.user?.bot) return;
    if (settings.guildId && newState.guild.id !== settings.guildId) return;

    if (
      settings.tempVoiceLobbyId &&
      newState.channelId === settings.tempVoiceLobbyId &&
      oldState.channelId !== newState.channelId
    ) {
      try {
        await findOrCreateTemporaryChannel(newState);
      } catch (error) {
        log(logger, "warn", "Temporary voice-channel creation failed", error);
      }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      scheduleTemporaryChannelDeletion(oldState.channelId, oldState.guild);
    }
    if (newState.channelId && db.getTempChannel(newState.channelId)) {
      await db.touchTempChannel(newState.channelId);
    }
    if (
      reactiveChannelId &&
      (oldState.channelId === reactiveChannelId || newState.channelId === reactiveChannelId)
    ) {
      const guild = newState.guild || oldState.guild;
      let channel = guild?.channels?.cache?.get?.(reactiveChannelId) || null;
      if (!channel && typeof guild?.channels?.fetch === "function") {
        channel = await guild.channels.fetch(reactiveChannelId).catch(() => null);
      }
      if (channel) publishReactiveSnapshot(channel);
    }
  }

  async function handleChannelDelete(channel) {
    if (db.getTempChannel(channel.id)) {
      await db.deleteTempChannel(channel.id);
    }
  }

  async function reconcileTemporaryChannels() {
    if (!settings.guildId) return;
    const guild =
      client.guilds.cache.get(settings.guildId) ??
      (await client.guilds.fetch(settings.guildId));
    for (const record of db.listTempChannels(settings.guildId)) {
      const channel =
        guild.channels.cache.get(record.channelId) ??
        (await guild.channels.fetch(record.channelId).catch(() => null));
      if (!channel) {
        await db.deleteTempChannel(record.channelId);
      } else if (!channel.members?.size) {
        scheduleTemporaryChannelDeletion(record.channelId, guild);
      }
    }
  }

  async function updateTempChannelPreferences(guildId, ownerUserId) {
    if (!client?.isReady?.()) return null;
    const record = db
      .listTempChannels(guildId)
      .find((item) => item.ownerUserId === ownerUserId);
    if (!record) return null;
    const guild =
      client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
    const channel =
      guild.channels.cache.get(record.channelId) ??
      (await guild.channels.fetch(record.channelId).catch(() => null));
    if (!channel?.isVoiceBased?.()) {
      await db.deleteTempChannel(record.channelId);
      return null;
    }
    const member = await guild.members.fetch(ownerUserId).catch(() => null);
    const preferences = normalizeVoicePreferences(
      db.getVoicePreferences(guildId, ownerUserId),
      `${member?.displayName ?? "Personal"}'s room`,
    );
    await channel.edit({
      name: preferences.name,
      userLimit: preferences.userLimit,
      permissionOverwrites: buildVoicePermissionOverwrites({
        everyoneRoleId: guild.roles.everyone.id,
        ownerUserId,
        visibility: preferences.visibility,
        whitelist: preferences.whitelist,
      }),
      reason: "Temporary voice-channel settings updated",
    });
    await db.saveTempChannel({ ...record, config: preferences });
    return channel;
  }

  async function enableReactiveSpeaking(options, callback) {
    const request =
      typeof options === "string"
        ? { channelId: options, onSpeaking: callback }
        : options ?? {};
    const channelId = request.channelId;
    if (!channelId) throw new TypeError("A reactive voice channel ID is required");
    const discordClient = ensureClient();
    if (!discordClient.isReady?.()) {
      throw new Error("Discord client is not ready");
    }

    disableReactiveSpeaking();
    // The voice package and its native/WASM-adjacent work stay off the hot path
    // until a reactive scene explicitly requests speaking events.
    const { joinVoiceChannel } = await import("@discordjs/voice");
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel?.isVoiceBased?.()) {
      throw new Error("Reactive speaking channel is not a voice channel");
    }
    voiceConnection = joinVoiceChannel({
      channelId,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    reactiveChannelId = channelId;

    const onStart = (userId) => {
      const member = channel.members?.get?.(String(userId));
      const event = {
        ...reactiveMember(member),
        userId: String(userId),
        speaking: true,
        channelId,
      };
      request.onSpeaking?.(event);
      sendBroadcast(broadcast, "discord.speaking", event);
    };
    const onEnd = (userId) => {
      const member = channel.members?.get?.(String(userId));
      const event = {
        ...reactiveMember(member),
        userId: String(userId),
        speaking: false,
        channelId,
      };
      request.onSpeaking?.(event);
      sendBroadcast(broadcast, "discord.speaking", event);
    };
    voiceConnection.receiver.speaking.on("start", onStart);
    voiceConnection.receiver.speaking.on("end", onEnd);
    reactiveCallbacks = { onStart, onEnd };
    return { channelId, snapshot: publishReactiveSnapshot(channel) };
  }

  function disableReactiveSpeaking() {
    if (voiceConnection && reactiveCallbacks) {
      voiceConnection.receiver.speaking.off(
        "start",
        reactiveCallbacks.onStart,
      );
      voiceConnection.receiver.speaking.off("end", reactiveCallbacks.onEnd);
    }
    voiceConnection?.destroy();
    voiceConnection = null;
    reactiveCallbacks = null;
    reactiveChannelId = null;
  }

  async function onReady() {
    started = true;
    log(logger, "info", `Discord bot connected as ${client.user?.tag ?? "bot"}`);
    try {
      await registerCommands();
    } catch (error) {
      log(logger, "warn", "Discord command registration failed", error);
    }
    await reconcileTemporaryChannels().catch((error) =>
      log(logger, "warn", "Discord voice reconciliation failed", error),
    );
    await refreshStatusPanel().catch((error) =>
      log(logger, "warn", "Discord status update failed", error),
    );
    if (settings.statusChannelId) {
      statusTimer = setInterval(() => {
        void refreshStatusPanel().catch((error) =>
          log(logger, "warn", "Discord status update failed", error),
        );
      }, settings.statusUpdateSeconds * 1_000);
      statusTimer.unref?.();
    }
    if (settings.reactiveVoiceChannelId) {
      await enableReactiveSpeaking({
        channelId: settings.reactiveVoiceChannelId,
      }).catch((error) =>
        log(logger, "warn", "Reactive Discord voice could not start", error),
      );
    }
  }

  function attachEvents() {
    client.once(Events.ClientReady, onReady);
    client.on(Events.InteractionCreate, (interaction) => {
      void handleInteraction(interaction).catch((error) => {
        log(logger, "error", "Discord interaction failed", error);
        void interactionReply(interaction, {
          content: "The command failed. Check the server logs.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      });
    });
    client.on(Events.GuildMemberAdd, (member) => void addAutoRole(member));
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      void handleVoiceState(oldState, newState).catch((error) =>
        log(logger, "warn", "Discord voice-state handling failed", error),
      );
    });
    client.on(Events.ChannelDelete, (channel) => {
      void handleChannelDelete(channel).catch((error) =>
        log(logger, "warn", "Discord channel cleanup failed", error),
      );
    });
    client.on(Events.Error, (error) =>
      {
        lastConnectionError = error.message;
        log(logger, "error", "Discord client error", error);
      },
    );
  }

  async function start() {
    if (!settings.token) {
      lastConnectionError = null;
      log(logger, "info", "Discord bot disabled: DISCORD_TOKEN is not configured");
      return botStatus();
    }
    if (started || client?.isReady?.()) return botStatus();
    const discordClient = ensureClient();
    try {
      await discordClient.login(settings.token);
      started = true;
      lastConnectionError = null;
    } catch (error) {
      lastConnectionError = error.message;
      throw error;
    }
    return botStatus();
  }

  async function stop() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    for (const timer of deleteTimers.values()) clearTimeout(timer);
    deleteTimers.clear();
    disableReactiveSpeaking();
    client?.destroy();
    if (ownsClient) client = null;
    started = false;
  }

  async function reloadSettings() {
    const storedValue = db.getSetting("settings:discord", {});
    let stored = storedValue;
    if (typeof storedValue === "string") {
      try {
        stored = JSON.parse(storedValue);
      } catch {
        stored = {};
      }
    }
    // Secret dashboard values are decrypted into config.discord by main.js or
    // the settings endpoint. Only non-secret settings are read directly here.
    const candidateStored =
      stored && typeof stored === "object"
        ? {
            guildId: stored.guildId,
            adminRoleIds: stored.adminRoleIds,
            ownerUserIds: stored.ownerUserIds,
            autoRoleId: stored.autoRoleId,
            statusChannelId: stored.statusChannelId,
            tempVoiceLobbyId: stored.tempVoiceLobbyId,
            tempVoiceCategoryId: stored.tempVoiceCategoryId,
            reactiveVoiceChannelId: stored.reactiveVoiceChannelId,
          }
        : {};
    const safeStored = Object.fromEntries(
      Object.entries(candidateStored).filter(([, value]) => value !== undefined),
    );
    settings = normalizeDiscordConfig({
      ...config,
      discord: { ...(config.discord ?? {}), ...safeStored },
    });
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (started && settings.statusChannelId) {
      statusTimer = setInterval(() => {
        void refreshStatusPanel().catch((error) =>
          log(logger, "warn", "Discord status update failed", error),
        );
      }, settings.statusUpdateSeconds * 1_000);
      statusTimer.unref?.();
      await refreshStatusPanel();
    }
    return botStatus();
  }

  async function restart() {
    await stop();
    await reloadSettings();
    return start();
  }

  // Supplied clients are primarily useful for integration tests.
  if (client) attachEvents();

  return {
    start,
    stop,
    restart,
    getStatus: botStatus,
    status: botStatus,
    registerCommands,
    refreshStatusPanel,
    reloadSettings,
    enableReactiveSpeaking,
    disableReactiveSpeaking,
    updateTempChannelPreferences,
    listVoiceChannels,
    reactiveContext,
    publishReactiveSnapshot,
    handleInteraction,
    handleVoiceState,
  };
}

export default createDiscordBot;
