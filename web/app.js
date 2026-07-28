const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const PROFILE_TYPES = ["chat", "alerts", "reactives", "timer", "spotify"];
const NUMBER_FIELDS = new Set([
  "messageLimit", "fontSize", "opacity", "duration", "radius", "width", "height",
  "secondsPerEvent", "startingSeconds", "goal", "backupRetention", "voiceDefaultLimit"
]);

const DEFAULT_PROFILES = {
  chat: {
    id: "default", name: "Main chat", channel: "", messageLimit: 20, showBadges: true,
    fontFamily: "System Sans", fontSize: 28, textColor: "#f5f7fb",
    accentColor: "#37e6b2", backgroundColor: "#0b1119", opacity: 82, animation: "rise"
  },
  alerts: {
    id: "default", name: "Main alerts", headline: "{user} just followed!",
    message: "Welcome to the forge.", duration: 7, animation: "impact", layout: "badge",
    textColor: "#ffffff", accentColor: "#ffb454", backgroundColor: "#101722", radius: 18
  },
  reactives: {
    id: "default", name: "Podcast", width: 1920, height: 1080, backgroundColor: "#121923",
    participants: [
      { id: crypto.randomUUID(), name: "Host", discordUserId: "", idleUrl: "", talkingUrl: "", x: 36, y: 58, size: 28 },
      { id: crypto.randomUUID(), name: "Guest", discordUserId: "", idleUrl: "", talkingUrl: "", x: 65, y: 58, size: 28 }
    ]
  },
  timer: {
    id: "default", name: "Follow timer", label: "THE FORGE STAYS LIVE", eventType: "follow",
    secondsPerEvent: 300, startingSeconds: 7200, goal: 50, layout: "industrial",
    textColor: "#f7fbff", accentColor: "#37e6b2", backgroundColor: "#0e151d"
  },
  spotify: {
    id: "default", name: "Now playing", displayMode: "change", duration: 12,
    position: "bottom-left", showAlbumArt: true, showProgress: true, layout: "card",
    textColor: "#ffffff", accentColor: "#1ed760", backgroundColor: "#121816"
  }
};

const state = {
  session: null,
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  profiles: Object.fromEntries(PROFILE_TYPES.map((type) => [type, []])),
  currentProfiles: {},
  loadedProfiles: new Set(),
  publicOrigin: location.origin,
  draggingParticipant: null
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body && typeof body !== "string" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    ...options,
    body,
    headers,
    credentials: "same-origin"
  });
  const contentType = response.headers.get("content-type") || "";
  const data = response.status === 204
    ? null
    : contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  if (!response.ok) {
    const message = data?.error || data?.message || `Request failed (${response.status})`;
    if (response.status === 401 && path !== "/api/auth/session" && path !== "/api/auth/login") {
      showLogin();
    }
    throw new ApiError(message, response.status, data);
  }
  return data;
}

function showLogin(message = "") {
  state.session = null;
  $("#loginShell").classList.remove("is-hidden");
  $("#appShell").classList.add("is-hidden");
  $("#loginMessage").textContent = message;
  state.socket?.close();
}

function showApp(session = {}) {
  state.session = session;
  $("#loginShell").classList.add("is-hidden");
  $("#appShell").classList.remove("is-hidden");
  const user = session.user || {};
  $("#userName").textContent = user.displayName || user.username || user.name || "Local admin";
  $("#userRole").textContent = user.role || "Owner";
  const avatar = $("#userAvatar");
  avatar.textContent = initials(user.displayName || user.username || user.name || "StreamForge");
  if (user.avatarUrl) {
    avatar.style.backgroundImage = `url("${safeCssUrl(user.avatarUrl)}")`;
    avatar.textContent = "";
  }
  connectSocket();
  navigate(location.hash.slice(1) || "overview", false);
}

function initials(value) {
  return String(value).trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function safeCssUrl(value) {
  return String(value).replace(/["\\\n\r]/g, "");
}

function toast(message, kind = "success") {
  const item = document.createElement("div");
  item.className = `toast${kind === "error" ? " is-error" : ""}`;
  item.setAttribute("role", kind === "error" ? "alert" : "status");
  item.innerHTML = `<span>${kind === "error" ? "!" : "✓"}</span><span></span>`;
  item.lastElementChild.textContent = message;
  $("#toastRegion").append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function setConnection(mode, text) {
  const pill = $("#connectionPill");
  pill.classList.toggle("is-online", mode === "online");
  pill.classList.toggle("is-offline", mode === "offline");
  $("span", pill).textContent = text;
}

function bindGlobalEvents() {
  $("#loginForm").addEventListener("submit", login);
  $("#logoutButton").addEventListener("click", logout);
  $("#menuButton").addEventListener("click", toggleSidebar);
  $("#sidebarScrim").addEventListener("click", closeSidebar);
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "overview", false));

  $$("[data-route]").forEach((link) => link.addEventListener("click", () => closeSidebar()));
  $$("[data-route-button]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.routeButton)));
  $$("[data-refresh]").forEach((button) => button.addEventListener("click", () => refreshStatus(true)));
  $("#clearActivity").addEventListener("click", () => { $("#activityList").innerHTML = ""; });

  $$("[data-dialog-open]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.dialogOpen).showModal());
  });
  $("#serviceForm").addEventListener("submit", createService);

  $$("[data-profile-form]").forEach(bindProfileForm);
  $$("[data-settings-form]").forEach(bindSettingsForm);

  $$("[data-copy-url]").forEach((button) => {
    button.addEventListener("click", () => copyOverlayUrl(button.dataset.copyUrl));
  });
  $$("[data-refresh-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      const iframe = button.closest(".preview-column")?.querySelector("iframe");
      if (iframe) iframe.src = iframe.src;
    });
  });
  $$("[data-test-overlay]").forEach((button) => {
    button.addEventListener("click", () => testOverlay(button.dataset.testOverlay));
  });
  $$("[data-timer-action]").forEach((button) => {
    button.addEventListener("click", () => controlTimer(button.dataset.timerAction));
  });

  $("#addParticipant").addEventListener("click", addParticipant);
  $("#sceneStage").addEventListener("pointerdown", beginParticipantDrag);
  window.addEventListener("pointermove", moveParticipant);
  window.addEventListener("pointerup", endParticipantDrag);

  $("#publishStatusPanel").addEventListener("click", () => discordAction("publish-status"));
  $("#testDiscord").addEventListener("click", () => discordAction("test"));
  $("#backupNow").addEventListener("click", runBackup);
  $("#testBackup").addEventListener("click", () => backupAction("test"));
  $("#refreshBackups").addEventListener("click", loadBackups);

  window.addEventListener("message", (event) => {
    if (event.origin === location.origin && event.data?.type === "streamforge:overlay-ready") {
      const type = event.data.overlayType;
      if (PROFILE_TYPES.includes(type)) postPreviewConfig(type);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  const accessKey = $("#accessKey").value;
  button.disabled = true;
  $("#loginMessage").textContent = "Opening your control room…";
  try {
    const session = await api("/api/auth/login", { method: "POST", body: { accessKey } });
    form.reset();
    $("#loginMessage").textContent = "";
    showApp(session);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // A failed logout request should still clear the local UI.
  }
  showLogin("Control room locked.");
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  const open = sidebar.classList.toggle("is-open");
  $("#menuButton").setAttribute("aria-expanded", String(open));
}

function closeSidebar() {
  $("#sidebar").classList.remove("is-open");
  $("#menuButton").setAttribute("aria-expanded", "false");
}

async function navigate(route, updateHash = true) {
  const validRoute = $(`[data-page="${CSS.escape(route)}"]`) ? route : "overview";
  $$(".page").forEach((page) => page.classList.toggle("is-active", page.dataset.page === validRoute));
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.route === validRoute));
  if (updateHash && location.hash !== `#${validRoute}`) history.pushState(null, "", `#${validRoute}`);
  document.title = `${routeTitle(validRoute)} · StreamForge Local`;
  closeSidebar();
  await loadRoute(validRoute);
  $("#workspace").focus({ preventScroll: true });
}

function routeTitle(route) {
  return {
    overview: "Overview", services: "Services", chat: "Twitch Chat", alerts: "Alerts",
    reactives: "Reactive Scene", timer: "Stream Timer", spotify: "Now Playing",
    discord: "Discord Bot", settings: "Backup & Settings"
  }[route] || "Control Room";
}

async function loadRoute(route) {
  if (route === "overview") await refreshStatus();
  if (route === "services") await loadServices();
  if (PROFILE_TYPES.includes(route)) await loadProfiles(route);
  if (route === "discord") await loadSettings("discord");
  if (route === "settings") {
    await Promise.allSettled([loadSettings("general"), loadBackups()]);
  }
}

function connectSocket() {
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  window.clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  setConnection("connecting", "Connecting");

  socket.addEventListener("open", () => {
    state.reconnectAttempts = 0;
    socket.send(JSON.stringify({ type: "subscribe", topics: ["*"] }));
    setConnection("online", "LAN online");
  });
  socket.addEventListener("message", ({ data }) => {
    try {
      handleSocketMessage(JSON.parse(data));
    } catch {
      addActivity("Malformed server event ignored", "warn");
    }
  });
  socket.addEventListener("close", () => {
    setConnection("offline", "Reconnecting");
    const delay = Math.min(15000, 1000 * (2 ** state.reconnectAttempts++));
    state.reconnectTimer = window.setTimeout(connectSocket, delay);
  });
  socket.addEventListener("error", () => socket.close());
}

function handleSocketMessage(event) {
  const type = event.type || "event";
  const payload = event.payload || event.data || {};
  if (type === "status") renderStatus(payload);
  if (type === "status-changed") refreshStatus();
  if (type === "service.status" || type === "services" || type === "service") {
    if ($('[data-page="services"]').classList.contains("is-active")) loadServices();
  }
  if (type.startsWith("discord.")) renderDiscordStatus(payload);
  if (type === "spotify.status") renderSpotifyStatus(payload);
  if (type === "activity" || event.message) {
    addActivity(event.message || payload.message || type, payload.level || event.level || "info");
  }
  $$("[data-overlay-preview]").forEach((frame) => {
    frame.contentWindow?.postMessage({ type: "streamforge:event", event }, location.origin);
  });
}

async function refreshStatus(showToast = false) {
  try {
    const data = await api("/api/status");
    renderStatus(data || {});
    if (showToast) toast("System status refreshed.");
  } catch (error) {
    setConnection("offline", "Server unavailable");
    $("#serverState").textContent = "Unavailable";
    $("#overviewSubtitle").textContent = error.message;
    if (showToast) toast(error.message, "error");
  }
}

function renderStatus(data) {
  const services = data.services || [];
  const running = services.filter((service) => service.status === "running").length;
  $("#serverState").textContent = data.ok === false ? "Needs attention" : "Online";
  $("#uptimeText").textContent = `Uptime ${formatDuration(data.uptimeSeconds || 0)}`;
  $("#runningServices").textContent = String(data.runningServices ?? running);
  $("#totalServices").textContent = `${data.totalServices ?? services.length} configured`;
  $("#serviceNavCount").textContent = String(data.runningServices ?? running);
  $("#overviewSubtitle").textContent = data.serverName || data.name
    ? `${data.serverName || data.name} is listening on your local network.`
    : "Your local stream stack is listening for commands.";
  renderDiscordStatus(data.discord || {});
  renderSpotifyStatus(data.spotify || {});

  const hostMemory = data.host?.memory || {};
  const derivedMemoryPercent = hostMemory.totalBytes
    ? (Number(hostMemory.usedBytes) / Number(hostMemory.totalBytes)) * 100
    : 0;
  const memoryPercent = clamp(data.device?.memoryPercent ?? data.memoryPercent ?? derivedMemoryPercent, 0, 100);
  const storagePercent = clamp(data.device?.storagePercent ?? 0, 0, 100);
  const batteryPercent = clamp(data.device?.batteryPercent ?? 0, 0, 100);
  setMeter("memory", memoryPercent);
  setMeter("storage", storagePercent);
  setMeter("battery", batteryPercent);
  setMeter("load", clamp(data.device?.loadPercent ?? memoryPercent, 0, 100));
  const processMemoryMb = data.device?.memoryMb ?? (hostMemory.processBytes ? Math.round(hostMemory.processBytes / 1048576) : null);
  $("#memoryText").textContent = processMemoryMb
    ? `${processMemoryMb} MB used by StreamForge`
    : "Low-power single process";
  if (data.device?.temperatureC != null) {
    $("#temperatureBadge").textContent = `${Math.round(data.device.temperatureC)}°C`;
  }
}

function renderDiscordStatus(discord) {
  const connected = Boolean(discord.connected || discord.ready);
  $("#discordState").textContent = connected ? "Connected" : (discord.configured ? "Offline" : "Not configured");
  $("#discordDetail").textContent = connected
    ? (discord.guildName || discord.username || "Gateway ready")
    : (discord.configured ? "Check the bot connection" : "Add a bot token to connect");
  const pill = $("#discordConnectionPill");
  pill.classList.toggle("is-online", connected);
  pill.classList.toggle("is-offline", !connected);
  $("span", pill).textContent = connected ? "Connected" : "Disconnected";
  $("#discordBotUser").textContent = discord.username || discord.botUser || "—";
  $("#discordGuild").textContent = discord.guildName || "—";
  $("#discordPing").textContent = discord.pingMs != null ? `${discord.pingMs} ms` : "—";
}

function renderSpotifyStatus(spotify) {
  const connected = Boolean(spotify.connected);
  $("#spotifyState").textContent = connected ? "Connected" : "Not connected";
  $("#spotifyDetail").textContent = spotify.track?.name || spotify.track?.title || (connected ? "Waiting for playback" : "Optional integration");
  $("#spotifyPreviewStatus").textContent = spotify.track?.name || spotify.track?.title || (connected ? "No song playing" : "Waiting for Spotify");
}

function setMeter(name, value) {
  $(`#${name}Meter`).style.width = `${value}%`;
  const percent = $(`#${name}Percent`);
  if (percent) percent.textContent = value ? `${Math.round(value)}%` : "—";
  if (name === "load") $("#loadPercent").textContent = value ? `${Math.round(value)}%` : "—";
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function addActivity(message, level = "info") {
  const item = document.createElement("li");
  const mark = document.createElement("i");
  mark.className = `activity-mark activity-mark--${level}`;
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = message;
  const detail = document.createElement("small");
  detail.textContent = "Server event";
  const time = document.createElement("time");
  time.textContent = "now";
  copy.append(title, detail);
  item.append(mark, copy, time);
  $("#activityList").prepend(item);
  $$("#activityList li").slice(20).forEach((oldItem) => oldItem.remove());
}

async function loadServices() {
  const list = $("#serviceList");
  try {
    const data = await api("/api/services");
    const services = Array.isArray(data) ? data : data?.services || [];
    renderServices(services);
  } catch (error) {
    list.innerHTML = "";
    list.append(emptyState("Could not load services", error.message));
  }
}

function renderServices(services) {
  const list = $("#serviceList");
  list.innerHTML = "";
  if (!services.length) {
    list.append(emptyState("No services configured", "Add a service such as a game server, tunnel, or helper script."));
    return;
  }
  for (const service of services) {
    const serviceStatus = typeof service.status === "string" ? { state: service.status } : (service.status || {});
    const running = serviceStatus.state === "running";
    const card = document.createElement("article");
    card.className = `service-card${running ? " is-running" : ""}`;
    card.innerHTML = `
      <header><i class="service-state"></i><div><h2></h2><small></small></div></header>
      <p></p>
      <div class="service-stats"><div><span>Status</span><strong></strong></div><div><span>Uptime</span><strong></strong></div><div><span>Restarts</span><strong></strong></div></div>
      <div class="service-actions">
        <button class="button button--primary" type="button" data-action="${running ? "restart" : "start"}">${running ? "Restart" : "Start"}</button>
        <button class="button button--secondary" type="button" data-action="stop" ${running ? "" : "disabled"}>Stop</button>
      </div>`;
    $("h2", card).textContent = service.name || service.id;
    $("header small", card).textContent = service.id;
    const commandSummary = [service.command, ...(service.args || [])].filter(Boolean).join(" ");
    $("p", card).textContent = commandSummary || "Allowlisted local service.";
    const stats = $$(".service-stats strong", card);
    stats[0].textContent = serviceStatus.state || "stopped";
    stats[1].textContent = running && serviceStatus.startedAt
      ? formatDuration((Date.now() - new Date(serviceStatus.startedAt).getTime()) / 1000)
      : "—";
    stats[2].textContent = String(serviceStatus.restarts || 0);
    $$("[data-action]", card).forEach((button) => button.addEventListener("click", () => serviceAction(service.id, button.dataset.action)));
    list.append(card);
  }
}

function emptyState(title, message) {
  const card = document.createElement("article");
  card.className = "empty-state";
  card.innerHTML = "<span>▶</span><h2></h2><p></p>";
  $("h2", card).textContent = title;
  $("p", card).textContent = message;
  return card;
}

async function createService(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitter = event.submitter;
  if (submitter?.value === "cancel") {
    $("#serviceDialog").close();
    return;
  }
  const fields = new FormData(form);
  const payload = {
    id: String(fields.get("id") || "").trim(),
    name: String(fields.get("name") || "").trim(),
    command: String(fields.get("command") || "").trim(),
    args: String(fields.get("args") || "")
      .split(/\r?\n/)
      .map((argument) => argument.trim())
      .filter(Boolean),
    cwd: String(fields.get("cwd") || "").trim() || null,
    enabled: fields.has("enabled"),
    autostart: fields.has("autostart")
  };
  try {
    await api("/api/services", { method: "POST", body: payload });
    $("#serviceDialog").close();
    form.reset();
    toast(`${payload.name} added.`);
    await loadServices();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function serviceAction(id, action) {
  try {
    await api(`/api/services/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    toast(`${action[0].toUpperCase()}${action.slice(1)} command sent.`);
    await loadServices();
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindProfileForm(form) {
  const type = form.dataset.profileForm;
  $("[data-profile-select]", form).addEventListener("change", (event) => {
    state.currentProfiles[type] = event.target.value;
    applyCurrentProfile(type);
  });
  $("[data-new-profile]", form).addEventListener("click", () => createProfileDraft(type));
  form.addEventListener("submit", (event) => saveProfile(event, type));
  form.addEventListener("input", (event) => {
    updateRangeOutput(event.target);
    markDirty(form);
    syncCurrentProfileFromForm(type);
    if (type === "reactives" && ["width", "height", "backgroundColor"].includes(event.target.name)) renderReactiveStage();
    postPreviewConfig(type);
  });
  $$('input[type="range"]', form).forEach(updateRangeOutput);
}

async function loadProfiles(type) {
  if (!state.loadedProfiles.has(type)) {
    try {
      const data = await api(`/api/profiles/${type}`);
      const profiles = Array.isArray(data) ? data : data?.profiles || [];
      state.profiles[type] = profiles.length
        ? profiles.map((profile) => normalizeProfileRecord(profile, true))
        : [{ ...structuredClone(DEFAULT_PROFILES[type]), _persisted: false }];
    } catch (error) {
      state.profiles[type] = [{ ...structuredClone(DEFAULT_PROFILES[type]), _persisted: false }];
      if (error.status !== 404) toast(`Using a local ${type} draft: ${error.message}`, "error");
    }
    state.loadedProfiles.add(type);
  }
  const current = state.currentProfiles[type];
  if (!current || !state.profiles[type].some((profile) => profile.id === current)) {
    state.currentProfiles[type] = state.profiles[type][0].id;
  }
  populateProfileSelect(type);
  applyCurrentProfile(type);
}

function populateProfileSelect(type) {
  const select = $(`[data-profile-form="${type}"] [data-profile-select]`);
  select.innerHTML = "";
  for (const profile of state.profiles[type]) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || "Untitled profile";
    option.selected = profile.id === state.currentProfiles[type];
    select.append(option);
  }
}

function applyCurrentProfile(type) {
  const form = $(`[data-profile-form="${type}"]`);
  const profile = getCurrentProfile(type);
  if (!form || !profile) return;
  for (const element of form.elements) {
    if (!element.name || !(element.name in profile)) continue;
    if (element.type === "checkbox") element.checked = Boolean(profile[element.name]);
    else element.value = profile[element.name] ?? "";
    updateRangeOutput(element);
  }
  if (type === "reactives") {
    profile.participants ||= [];
    renderParticipants();
    renderReactiveStage();
  }
  setSaved(form);
  updateOverlayUrl(type);
  setPreviewSource(type);
}

function getCurrentProfile(type) {
  return state.profiles[type]?.find((profile) => profile.id === state.currentProfiles[type]);
}

function syncCurrentProfileFromForm(type) {
  const profile = getCurrentProfile(type);
  const form = $(`[data-profile-form="${type}"]`);
  if (!profile || !form) return;
  Object.assign(profile, formValues(form));
}

function formValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled || element.type === "submit" || element.type === "button") continue;
    if (element.dataset.secret !== undefined && !element.value) continue;
    if (element.type === "checkbox") values[element.name] = element.checked;
    else if (NUMBER_FIELDS.has(element.name) || element.type === "number" || element.type === "range") values[element.name] = Number(element.value);
    else values[element.name] = element.value;
  }
  return values;
}

function createProfileDraft(type) {
  const suggested = `New ${type === "reactives" ? "scene" : "profile"}`;
  const name = window.prompt("Name this profile", suggested)?.trim();
  if (!name) return;
  const profile = {
    ...structuredClone(DEFAULT_PROFILES[type]),
    id: `draft-${crypto.randomUUID()}`,
    name,
    _persisted: false
  };
  state.profiles[type].push(profile);
  state.currentProfiles[type] = profile.id;
  populateProfileSelect(type);
  applyCurrentProfile(type);
  markDirty($(`[data-profile-form="${type}"]`));
}

async function saveProfile(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  const profile = getCurrentProfile(type);
  if (!profile) return;
  syncCurrentProfileFromForm(type);
  const configPayload = { ...profile };
  for (const key of ["id", "type", "kind", "name", "_persisted"]) delete configPayload[key];
  if (type === "timer") configPayload.durationSeconds = Number(configPayload.startingSeconds) || 0;
  const payload = { name: profile.name, config: configPayload };
  try {
    const saved = profile._persisted
      ? await api(`/api/profiles/${type}/${encodeURIComponent(profile.id)}`, { method: "PUT", body: payload })
      : await api(`/api/profiles/${type}`, { method: "POST", body: payload });
    const normalized = normalizeProfileRecord(saved?.profile || saved || { ...payload, id: profile.id }, true);
    Object.assign(profile, normalized);
    state.currentProfiles[type] = profile.id;
    populateProfileSelect(type);
    setSaved(form);
    updateOverlayUrl(type);
    setPreviewSource(type);
    toast(`${profile.name} saved.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function markDirty(form) {
  $$("[data-save-state]", form.closest(".page")).forEach((indicator) => {
    indicator.textContent = "Unsaved changes";
    indicator.classList.add("is-dirty");
    indicator.classList.remove("is-saved");
  });
}

function normalizeProfileRecord(record, persisted = false) {
  const storedConfig = record?.config && typeof record.config === "object" ? record.config : {};
  const flattened = {
    ...record,
    ...storedConfig,
    id: record?.id || crypto.randomUUID(),
    name: record?.name || storedConfig.name || "Untitled profile",
    _persisted: persisted
  };
  delete flattened.config;
  if (flattened.durationSeconds != null && flattened.startingSeconds == null) {
    flattened.startingSeconds = Number(flattened.durationSeconds);
  }
  return flattened;
}

function setSaved(form) {
  $$("[data-save-state]", form.closest(".page")).forEach((indicator) => {
    indicator.textContent = "All changes saved";
    indicator.classList.remove("is-dirty");
    indicator.classList.add("is-saved");
  });
}

function updateRangeOutput(element) {
  if (element.type !== "range") return;
  const output = element.closest(".range-field")?.querySelector("output");
  if (!output) return;
  output.value = `${element.value}${element.name === "opacity" ? "%" : "px"}`;
}

function overlayUrl(type) {
  const profile = getCurrentProfile(type);
  const origin = state.publicOrigin.replace(/\/$/, "");
  return `${origin}/overlay.html?type=${encodeURIComponent(type)}&profile=${encodeURIComponent(profile?.id || "default")}`;
}

function updateOverlayUrl(type) {
  const input = $(`[data-overlay-url="${type}"]`);
  if (input) input.value = overlayUrl(type);
}

function setPreviewSource(type) {
  const iframe = $(`[data-overlay-preview="${type}"]`);
  if (!iframe) return;
  const profile = getCurrentProfile(type);
  const url = `/overlay.html?type=${encodeURIComponent(type)}&profile=${encodeURIComponent(profile?.id || "default")}&preview=1`;
  if (iframe.getAttribute("src") !== url) iframe.src = url;
}

function postPreviewConfig(type) {
  const iframe = $(`[data-overlay-preview="${type}"]`);
  const profile = getCurrentProfile(type);
  iframe?.contentWindow?.postMessage({ type: "streamforge:preview", overlayType: type, config: profile }, location.origin);
}

async function copyOverlayUrl(type) {
  const value = overlayUrl(type);
  try {
    await navigator.clipboard.writeText(value);
    toast("OBS URL copied.");
  } catch {
    const input = $(`[data-overlay-url="${type}"]`);
    input.select();
    document.execCommand("copy");
    toast("OBS URL copied.");
  }
}

async function testOverlay(type) {
  const profile = getCurrentProfile(type);
  if (!profile) return;
  postPreviewConfig(type);
  const sample = {
    chat: { user: "ForgeViewer", message: "This chat style looks great!", color: "#ffb454", badges: ["MOD"] },
    alerts: { eventType: "follow", user: "ForgeViewer", message: "Welcome to the forge." },
    reactives: { participantId: profile.participants?.[0]?.id, speaking: true },
    spotify: { track: { name: "Midnight Circuit", artist: "Signal Array", album: "Afterglow", progressMs: 74000, durationMs: 218000 } }
  }[type] || {};
  const iframe = $(`[data-overlay-preview="${type}"]`);
  iframe?.contentWindow?.postMessage({
    type: "streamforge:event",
    event: { type: `${type}.test`, payload: sample }
  }, location.origin);
  try {
    await api(`/api/overlays/${type}/test`, { method: "POST", body: { profileId: profile.id, ...sample } });
    toast(`Test ${type === "reactives" ? "voice activity" : type} sent.`);
  } catch (error) {
    if (error.status === 404) toast("Preview test shown locally; server broadcast is not available yet.");
    else toast(error.message, "error");
  }
}

function renderParticipants() {
  const profile = getCurrentProfile("reactives");
  const list = $("#participantList");
  list.innerHTML = "";
  for (const participant of profile?.participants || []) {
    const fragment = $("#participantTemplate").content.cloneNode(true);
    const card = $(".participant-card", fragment);
    card.dataset.participantId = participant.id;
    $("[data-participant-label]", card).textContent = participant.name || "Participant";
    $$("[data-participant-field]", card).forEach((input) => {
      const key = input.dataset.participantField;
      input.value = participant[key] ?? "";
      input.addEventListener("input", () => {
        participant[key] = input.type === "number" ? Number(input.value) : input.value;
        if (key === "name") $("[data-participant-label]", card).textContent = input.value || "Participant";
        markDirty($('[data-profile-form="reactives"]'));
        renderReactiveStage();
        postPreviewConfig("reactives");
      });
    });
    $("[data-remove-participant]", card).addEventListener("click", () => removeParticipant(participant.id));
    list.append(fragment);
  }
}

function addParticipant() {
  const profile = getCurrentProfile("reactives");
  if (!profile) return;
  profile.participants ||= [];
  profile.participants.push({
    id: crypto.randomUUID(),
    name: `Speaker ${profile.participants.length + 1}`,
    discordUserId: "",
    idleUrl: "",
    talkingUrl: "",
    x: 50,
    y: 58,
    size: 26
  });
  renderParticipants();
  renderReactiveStage();
  markDirty($('[data-profile-form="reactives"]'));
}

function removeParticipant(id) {
  const profile = getCurrentProfile("reactives");
  if (!profile) return;
  profile.participants = (profile.participants || []).filter((participant) => participant.id !== id);
  renderParticipants();
  renderReactiveStage();
  markDirty($('[data-profile-form="reactives"]'));
}

function renderReactiveStage() {
  const profile = getCurrentProfile("reactives");
  const stage = $("#sceneStage");
  if (!profile) return;
  stage.style.backgroundColor = profile.backgroundColor || "#121923";
  $("#canvasSize").textContent = `${profile.width || 1920} × ${profile.height || 1080}`;
  stage.innerHTML = "";
  for (const participant of profile.participants || []) {
    const node = document.createElement("div");
    node.className = "stage-participant";
    node.dataset.participantId = participant.id;
    node.style.left = `${clamp(participant.x, 0, 100)}%`;
    node.style.top = `${clamp(participant.y, 0, 100)}%`;
    node.style.width = `${clamp(participant.size, 10, 100)}%`;
    if (participant.idleUrl) {
      const image = document.createElement("img");
      image.src = participant.idleUrl;
      image.alt = "";
      node.append(image);
    }
    const label = document.createElement("span");
    label.textContent = participant.name || "Participant";
    node.append(label);
    stage.append(node);
  }
}

function beginParticipantDrag(event) {
  const node = event.target.closest(".stage-participant");
  if (!node) return;
  event.preventDefault();
  node.setPointerCapture?.(event.pointerId);
  state.draggingParticipant = { id: node.dataset.participantId, pointerId: event.pointerId };
}

function moveParticipant(event) {
  if (!state.draggingParticipant || event.pointerId !== state.draggingParticipant.pointerId) return;
  const stage = $("#sceneStage");
  const rect = stage.getBoundingClientRect();
  const profile = getCurrentProfile("reactives");
  const participant = profile?.participants?.find((item) => item.id === state.draggingParticipant.id);
  if (!participant) return;
  participant.x = Math.round(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  participant.y = Math.round(clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100));
  const node = $(`.stage-participant[data-participant-id="${CSS.escape(participant.id)}"]`, stage);
  node.style.left = `${participant.x}%`;
  node.style.top = `${participant.y}%`;
  const card = $(`.participant-card[data-participant-id="${CSS.escape(participant.id)}"]`);
  $('[data-participant-field="x"]', card).value = participant.x;
  $('[data-participant-field="y"]', card).value = participant.y;
  markDirty($('[data-profile-form="reactives"]'));
}

function endParticipantDrag(event) {
  if (!state.draggingParticipant || event.pointerId !== state.draggingParticipant.pointerId) return;
  state.draggingParticipant = null;
  postPreviewConfig("reactives");
}

async function controlTimer(action) {
  const profile = getCurrentProfile("timer");
  if (!profile) return;
  if (action === "reset" && !window.confirm("Reset this timer to its configured starting time?")) return;
  try {
    await api(`/api/timer/${encodeURIComponent(profile.id)}/control`, {
      method: "POST",
      body: { action, seconds: action === "add" ? Number(profile.secondsPerEvent) || 0 : undefined }
    });
    toast(`Timer ${action} command sent.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindSettingsForm(form) {
  form.addEventListener("input", () => markDirty(form));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const scope = form.dataset.settingsForm;
    try {
      const values = formValues(form);
      const result = await api(`/api/settings/${scope}`, { method: "PUT", body: values });
      if (scope === "general") {
        state.publicOrigin = result?.settings?.publicOrigin || result?.publicOrigin || values.publicOrigin || location.origin;
        PROFILE_TYPES.forEach(updateOverlayUrl);
      }
      if (scope === "discord") {
        const submittedSecrets = {
          botTokenConfigured: Boolean(values.botToken),
          clientSecretConfigured: Boolean(values.clientSecret)
        };
        $$("[data-secret]", form).forEach((input) => { input.value = ""; });
        renderDiscordConfiguration(result, submittedSecrets);
        if (result?.status) renderDiscordStatus(result.status);
      }
      setSaved(form);
      toast(`${scope === "discord" ? "Discord" : "Server"} settings saved.`);
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function loadSettings(scope) {
  const form = $(`[data-settings-form="${scope}"]`);
  try {
    const response = await api(`/api/settings/${scope}`);
    const data = response?.settings || response || {};
    for (const element of form.elements) {
      if (element.dataset.secret !== undefined) {
        element.value = "";
        continue;
      }
      if (!element.name || !(element.name in data)) continue;
      if (element.type === "checkbox") element.checked = Boolean(data[element.name]);
      else element.value = data[element.name] ?? "";
    }
    if (scope === "general") {
      state.publicOrigin = data.publicOrigin || location.origin;
      PROFILE_TYPES.forEach(updateOverlayUrl);
      $("#backupProviderState").textContent = data.backupConnected
        ? String(data.backupProvider || "cloud").replace("-", " ")
        : "LOCAL ONLY";
    }
    if (scope === "discord") {
      renderDiscordConfiguration(response, data);
      if (response?.status || data.status) renderDiscordStatus(response?.status || data.status);
    }
    setSaved(form);
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderDiscordConfiguration(response = {}, fallback = {}) {
  const settings = response?.settings || {};
  const flags = response?.configured || settings.configured || {};
  const botTokenConfigured = Boolean(
    response?.botTokenConfigured ??
    settings.botTokenConfigured ??
    flags.botToken ??
    fallback.botTokenConfigured
  );
  const clientSecretConfigured = Boolean(
    response?.clientSecretConfigured ??
    settings.clientSecretConfigured ??
    flags.clientSecret ??
    fallback.clientSecretConfigured
  );
  const botTokenInput = $('[name="botToken"]');
  const clientSecretInput = $('[name="clientSecret"]');
  if (botTokenInput) botTokenInput.placeholder = botTokenConfigured ? "Configured ••••••••" : "Not configured";
  if (clientSecretInput) clientSecretInput.placeholder = clientSecretConfigured ? "Configured ••••••••" : "Not configured";
  setCredentialFlag("#botTokenFlag", "Bot token", botTokenConfigured);
  setCredentialFlag("#clientSecretFlag", "OAuth secret", clientSecretConfigured);
  const stateTag = $("#discordCredentialState");
  stateTag.textContent = botTokenConfigured ? (clientSecretConfigured ? "BOT + LOGIN READY" : "BOT READY") : "SETUP REQUIRED";
  const connectionError =
    response?.connectionError ||
    response?.status?.connectionError ||
    settings.connectionError ||
    fallback.connectionError ||
    "";
  $("#discordConnectionError").textContent = connectionError;
}

function setCredentialFlag(selector, label, configured) {
  const flag = $(selector);
  flag.textContent = `${label} · ${configured ? "configured" : "not set"}`;
  flag.classList.toggle("is-configured", configured);
}

async function discordAction(action) {
  try {
    const data = await api(`/api/discord/${action}`, { method: "POST" });
    if (data?.status) renderDiscordStatus(data.status);
    toast(action === "test" ? "Discord connection test complete." : "Discord status panel updated.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runBackup() {
  const button = $("#backupNow");
  button.disabled = true;
  button.textContent = "Backing up…";
  try {
    await api("/api/backups/run", { method: "POST" });
    toast("Backup started.");
    window.setTimeout(() => loadBackups(), 1_000);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Back up now";
  }
}

async function backupAction(action) {
  try {
    await api(`/api/backups/${action}`, { method: "POST" });
    toast("Backup destination is reachable.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadBackups() {
  const body = $("#backupList");
  try {
    const data = await api("/api/backups");
    const backups = Array.isArray(data)
      ? data
      : data?.backups || (data?.lastResult ? [{
        createdAt: data.lastResult.at,
        destination: data.cloudConfigured ? "Cloud + local" : "Local",
        sizeBytes: data.lastResult.sizeBytes,
        status: data.lastResult.ok ? "complete" : "failed"
      }] : []);
    body.innerHTML = "";
    if (!backups.length) {
      body.innerHTML = '<tr><td colspan="4" class="table-empty">No backups yet.</td></tr>';
      return;
    }
    for (const backup of backups) {
      const row = document.createElement("tr");
      for (const value of [
        new Date(backup.createdAt).toLocaleString(),
        backup.destination || "Local",
        formatBytes(backup.sizeBytes),
        backup.status || "complete"
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  } catch (error) {
    body.innerHTML = "";
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "table-empty";
    cell.textContent = error.message;
    row.append(cell);
    body.append(row);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

async function bootstrap() {
  bindGlobalEvents();
  try {
    const session = await api("/api/auth/session");
    if (session?.authenticated === false) showLogin();
    else showApp(session || {});
  } catch (error) {
    showLogin(error.status === 401 ? "" : "Could not reach the local server.");
  }
}

bootstrap();
