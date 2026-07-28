const params = new URLSearchParams(location.search);
const overlayType = params.get("type") || "chat";
const profileId = params.get("profile") || "default";
const isPreview = params.get("preview") === "1";
const allowedTypes = new Set(["chat", "alerts", "reactives", "timer", "spotify"]);

const root = document.querySelector("#overlayRoot");
const statusNode = document.querySelector("#overlayStatus");
let config = {};
let localSocket = null;
let ircSocket = null;
let ircReconnectTimer = null;
let alertTimer = null;
let alertQueue = [];
let timerState = { remainingSeconds: 0, running: false, eventCount: 0, updatedAt: Date.now() };
let spotifyTrack = null;
let progressInterval = null;

const fallbacks = {
  chat: {
    channel: "", messageLimit: 20, showBadges: true, fontFamily: "System Sans",
    fontSize: 28, textColor: "#f5f7fb", accentColor: "#37e6b2",
    backgroundColor: "#0b1119", opacity: 82, animation: "rise"
  },
  alerts: {
    headline: "{user} just followed!", message: "Welcome to the forge.", duration: 7,
    animation: "impact", layout: "badge", textColor: "#ffffff",
    accentColor: "#ffb454", backgroundColor: "#101722", radius: 18
  },
  reactives: {
    width: 1920, height: 1080, backgroundColor: "transparent", participants: []
  },
  timer: {
    label: "THE FORGE STAYS LIVE", eventType: "follow", secondsPerEvent: 300,
    startingSeconds: 7200, goal: 50, layout: "industrial", textColor: "#f7fbff",
    accentColor: "#37e6b2", backgroundColor: "#0e151d"
  },
  spotify: {
    displayMode: "change", duration: 12, position: "bottom-left", showAlbumArt: true,
    showProgress: true, layout: "card", textColor: "#ffffff",
    accentColor: "#1ed760", backgroundColor: "#121816"
  }
};

function setStatus(text, mode = "") {
  statusNode.textContent = text;
  statusNode.classList.toggle("is-ready", mode === "ready");
  statusNode.classList.toggle("is-error", mode === "error");
}

async function getJson(path) {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function rgbTuple(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return match
    ? `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}`
    : "11, 17, 25";
}

function fontStack(value) {
  return {
    "System Sans": 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    Rounded: '"Arial Rounded MT Bold", ui-rounded, sans-serif',
    Monospace: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
    Serif: 'Georgia, "Times New Roman", serif'
  }[value] || 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
}

function applyConfig(nextConfig) {
  config = { ...(fallbacks[overlayType] || {}), ...(nextConfig || {}) };
  if (overlayType === "timer" && config.timerState) updateTimerState(config.timerState);
  const styles = document.documentElement.style;
  styles.setProperty("--text", config.textColor || "#f5f7fb");
  styles.setProperty("--accent", config.accentColor || "#37e6b2");
  styles.setProperty("--panel", config.backgroundColor || "#0b1119");
  styles.setProperty("--panel-rgb", rgbTuple(config.backgroundColor));
  styles.setProperty("--opacity", String((Number(config.opacity ?? 90)) / 100));
  styles.setProperty("--radius", `${Number(config.radius ?? 18)}px`);
  styles.setProperty("--font-size", `${Number(config.fontSize ?? 28)}px`);
  styles.setProperty("--font-family", fontStack(config.fontFamily));
  renderOverlay();
}

function renderOverlay() {
  if (overlayType === "chat") renderChatShell();
  if (overlayType === "alerts") renderAlertShell();
  if (overlayType === "reactives") renderReactiveScene();
  if (overlayType === "timer") renderTimer();
  if (overlayType === "spotify") renderSpotify();
}

function renderChatShell() {
  let container = root.querySelector(".chat-overlay");
  if (!container) {
    root.innerHTML = "";
    container = document.createElement("div");
    container.className = "chat-overlay";
    root.append(container);
  }
}

function appendChatMessage(message) {
  const container = root.querySelector(".chat-overlay");
  if (!container) return;
  const item = document.createElement("div");
  item.className = "chat-message";
  item.dataset.animation = config.animation || "rise";
  item.style.setProperty("--user-color", message.color || config.accentColor || "#37e6b2");
  const author = document.createElement("span");
  author.className = "chat-author";
  if (config.showBadges && message.badges?.length) {
    for (const badge of message.badges.slice(0, 3)) {
      const badgeNode = document.createElement("i");
      badgeNode.className = "chat-badge";
      badgeNode.textContent = badgeLabel(badge);
      author.append(badgeNode);
    }
  }
  const name = document.createElement("span");
  name.textContent = message.user || "viewer";
  author.append(name);
  const text = document.createElement("span");
  text.className = "chat-text";
  text.textContent = ` ${message.message || ""}`;
  item.append(author, text);
  container.append(item);
  const limit = Math.max(2, Math.min(100, Number(config.messageLimit) || 20));
  while (container.children.length > limit) container.firstElementChild.remove();
}

function badgeLabel(value) {
  return String(value).split("/")[0].slice(0, 3).toUpperCase();
}

function renderAlertShell() {
  if (root.querySelector(".alert-overlay")) {
    const card = root.querySelector(".alert-card");
    card.dataset.layout = config.layout || "badge";
    card.dataset.animation = config.animation || "impact";
    return;
  }
  root.innerHTML = `
    <div class="alert-overlay">
      <article class="alert-card">
        <div class="alert-symbol">!</div>
        <div class="alert-copy">
          <span class="alert-kicker">STREAM EVENT</span>
          <h1 class="alert-title"></h1>
          <p class="alert-message"></p>
        </div>
      </article>
    </div>`;
  const card = root.querySelector(".alert-card");
  card.dataset.layout = config.layout || "badge";
  card.dataset.animation = config.animation || "impact";
}

function enqueueAlert(payload) {
  alertQueue.push(payload);
  if (!alertTimer) showNextAlert();
}

function showNextAlert() {
  const payload = alertQueue.shift();
  if (!payload) {
    alertTimer = null;
    return;
  }
  const card = root.querySelector(".alert-card");
  if (!card) return;
  const user = payload.user || "ForgeViewer";
  const headlineTemplate = payload.headline || config.headline || "{user} just followed!";
  root.querySelector(".alert-title").textContent = headlineTemplate.replaceAll("{user}", user);
  root.querySelector(".alert-message").textContent = payload.message || config.message || "";
  root.querySelector(".alert-kicker").textContent = eventLabel(payload.eventType);
  root.querySelector(".alert-symbol").textContent = eventSymbol(payload.eventType);
  card.classList.remove("is-visible");
  void card.offsetWidth;
  card.classList.add("is-visible");
  const duration = Math.max(2, Math.min(30, Number(config.duration) || 7)) * 1000;
  alertTimer = window.setTimeout(() => {
    card.classList.remove("is-visible");
    window.setTimeout(showNextAlert, 350);
  }, duration);
}

function eventLabel(type = "follow") {
  return {
    follow: "NEW FOLLOWER", subscription: "NEW SUBSCRIPTION", sub: "NEW SUBSCRIPTION",
    raid: "INCOMING RAID", tip: "NEW TIP"
  }[type] || "STREAM EVENT";
}

function eventSymbol(type = "follow") {
  return { follow: "+", subscription: "★", sub: "★", raid: "↗", tip: "$" }[type] || "!";
}

function renderReactiveScene() {
  root.innerHTML = "";
  const scene = document.createElement("div");
  scene.className = "reactive-overlay";
  if (config.backgroundColor && config.backgroundColor !== "transparent") {
    scene.style.backgroundColor = config.backgroundColor;
  }
  for (const participant of config.participants || []) {
    const person = document.createElement("div");
    person.className = "reactive-person";
    person.dataset.participantId = participant.id;
    person.dataset.discordUserId = participant.discordUserId || "";
    person.style.left = `${clamp(participant.x, 0, 100)}%`;
    person.style.top = `${clamp(participant.y, 0, 100)}%`;
    person.style.width = `${clamp(participant.size, 10, 100)}%`;
    if (participant.idleUrl) {
      const image = document.createElement("img");
      image.src = participant.idleUrl;
      image.alt = "";
      image.dataset.idleUrl = participant.idleUrl;
      image.dataset.talkingUrl = participant.talkingUrl || participant.idleUrl;
      person.append(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "reactive-placeholder";
      placeholder.textContent = initials(participant.name || "?");
      person.append(placeholder);
    }
    const label = document.createElement("span");
    label.className = "reactive-name";
    label.textContent = participant.name || "Speaker";
    person.append(label);
    scene.append(person);
  }
  root.append(scene);
}

function setSpeaking(payload) {
  const selector = payload.participantId
    ? `[data-participant-id="${CSS.escape(String(payload.participantId))}"]`
    : `[data-discord-user-id="${CSS.escape(String(payload.discordUserId || payload.userId || ""))}"]`;
  const person = root.querySelector(selector);
  if (!person) return;
  const speaking = Boolean(payload.speaking);
  person.classList.toggle("is-speaking", speaking);
  const image = person.querySelector("img");
  if (image) image.src = speaking ? image.dataset.talkingUrl : image.dataset.idleUrl;
  if (speaking && isPreview) window.setTimeout(() => {
    person.classList.remove("is-speaking");
    if (image) image.src = image.dataset.idleUrl;
  }, 1500);
}

function initials(value) {
  return String(value).trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function renderTimer() {
  if (!root.querySelector(".timer-overlay")) {
    root.innerHTML = `
      <div class="timer-overlay">
        <article class="timer-card">
          <span class="timer-label"></span>
          <div class="timer-digits">00:00:00</div>
          <div class="timer-meta"><span class="timer-event"></span><span class="timer-goal"></span></div>
        </article>
      </div>`;
  }
  const card = root.querySelector(".timer-card");
  card.dataset.layout = config.layout || "industrial";
  root.querySelector(".timer-label").textContent = config.label || "STREAM TIMER";
  root.querySelector(".timer-event").textContent = `+${formatShortDuration(config.secondsPerEvent || 0)} / ${config.eventType || "event"}`;
  root.querySelector(".timer-goal").textContent = `${timerState.eventCount || 0} / ${config.goal || "—"} GOAL`;
  root.querySelector(".timer-digits").textContent = formatClock(currentRemainingSeconds());
}

function currentRemainingSeconds() {
  let remaining = Number(timerState.remainingSeconds ?? config.startingSeconds) || 0;
  if (timerState.running) {
    remaining -= Math.floor((Date.now() - Number(timerState.updatedAt || Date.now())) / 1000);
  }
  return Math.max(0, remaining);
}

function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatShortDuration(seconds) {
  const value = Number(seconds) || 0;
  if (value % 60 === 0) return `${value / 60}M`;
  return `${value}S`;
}

function updateTimerState(payload) {
  const remainingSeconds = payload.remainingSeconds != null
    ? Number(payload.remainingSeconds)
    : payload.remainingMs != null
      ? Number(payload.remainingMs) / 1000
      : timerState.remainingSeconds;
  timerState = {
    ...timerState,
    ...payload,
    remainingSeconds,
    updatedAt: payload.updatedAt ? new Date(payload.updatedAt).getTime() : Date.now()
  };
  renderTimer();
}

function renderSpotify() {
  if (!root.querySelector(".spotify-overlay")) {
    root.innerHTML = `
      <div class="spotify-overlay">
        <article class="song-card">
          <div class="song-cover"><span>SF</span></div>
          <div class="song-copy">
            <span class="song-kicker">NOW PLAYING</span>
            <strong class="song-title"></strong>
            <span class="song-artist"></span>
            <div class="song-progress"><i></i></div>
          </div>
        </article>
      </div>`;
  }
  const overlay = root.querySelector(".spotify-overlay");
  const card = root.querySelector(".song-card");
  overlay.dataset.position = config.position || "bottom-left";
  card.dataset.layout = config.layout || "card";
  const track = spotifyTrack || {
    name: isPreview ? "Midnight Circuit" : "Nothing playing",
    artist: isPreview ? "Signal Array" : "Spotify",
    progressMs: 74000,
    durationMs: 218000
  };
  root.querySelector(".song-title").textContent = track.name || "Unknown track";
  root.querySelector(".song-artist").textContent = track.artist || track.artists?.join(", ") || "Unknown artist";
  const cover = root.querySelector(".song-cover");
  cover.hidden = !config.showAlbumArt;
  cover.querySelector("img")?.remove();
  if (track.albumArtUrl && config.showAlbumArt) {
    const image = document.createElement("img");
    image.src = track.albumArtUrl;
    image.alt = "";
    cover.append(image);
  }
  root.querySelector(".song-progress").hidden = !config.showProgress;
  updateSpotifyProgress(track);
}

function updateSpotifyProgress(track = spotifyTrack) {
  if (!track) return;
  let progress = Number(track.progressMs) || 0;
  if (track.isPlaying && track.updatedAt) progress += Date.now() - new Date(track.updatedAt).getTime();
  const percentage = clamp((progress / Math.max(1, Number(track.durationMs) || 1)) * 100, 0, 100);
  root.querySelector(".song-progress i")?.style.setProperty("--progress", `${percentage}%`);
}

function updateSpotify(payload) {
  const raw = payload.track || payload;
  spotifyTrack = raw ? {
    ...raw,
    name: raw.name || raw.title,
    artist: raw.artist || raw.artists?.join(", "),
    albumArtUrl: raw.albumArtUrl || raw.artwork,
    isPlaying: raw.isPlaying ?? payload.playing,
    progressMs: raw.progressMs ?? payload.progressMs,
    updatedAt: raw.updatedAt || new Date().toISOString()
  } : null;
  renderSpotify();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function parseTags(input) {
  return Object.fromEntries(input.split(";").map((entry) => {
    const [key, rawValue = ""] = entry.split("=");
    const value = rawValue
      .replaceAll("\\s", " ")
      .replaceAll("\\:", ";")
      .replaceAll("\\\\", "\\")
      .replaceAll("\\r", "\r")
      .replaceAll("\\n", "\n");
    return [key, value];
  }));
}

function parseIrcLine(line) {
  const match = line.match(/^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #[^ ]+ :([\s\S]*)$/);
  if (!match) return null;
  const tags = parseTags(match[1]);
  return {
    user: tags["display-name"] || match[2],
    message: match[3],
    color: tags.color || config.accentColor,
    badges: tags.badges ? tags.badges.split(",") : []
  };
}

function connectIrc() {
  window.clearTimeout(ircReconnectTimer);
  ircSocket?.close();
  const channel = String(config.channel || "").trim().replace(/^#/, "").toLowerCase();
  if (!channel || overlayType !== "chat") {
    setStatus(isPreview ? "PREVIEW" : "TWITCH CHANNEL MISSING", isPreview ? "ready" : "error");
    return;
  }
  const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ircSocket = socket;
  socket.addEventListener("open", () => {
    const nick = `justinfan${Math.floor(10000 + Math.random() * 80000)}`;
    socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    socket.send("PASS SCHMOOPIIE");
    socket.send(`NICK ${nick}`);
    socket.send(`JOIN #${channel}`);
    setStatus("TWITCH CONNECTED", "ready");
  });
  socket.addEventListener("message", ({ data }) => {
    for (const line of String(data).split("\r\n")) {
      if (line.startsWith("PING")) socket.send(line.replace("PING", "PONG"));
      const message = parseIrcLine(line);
      if (message) appendChatMessage(message);
    }
  });
  socket.addEventListener("close", () => {
    setStatus("TWITCH RECONNECTING");
    ircReconnectTimer = window.setTimeout(connectIrc, 5000);
  });
  socket.addEventListener("error", () => socket.close());
}

function connectLocalSocket() {
  if (overlayType === "chat") return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  localSocket = socket;
  socket.addEventListener("open", () => setStatus("LOCAL FEED CONNECTED", "ready"));
  socket.addEventListener("open", () => {
    const topics = [`${overlayType}:${profileId}`];
    if (overlayType === "spotify") topics.push("spotify");
    socket.send(JSON.stringify({ type: "subscribe", topics }));
  });
  socket.addEventListener("message", ({ data }) => {
    try {
      handleEvent(JSON.parse(data));
    } catch {
      // Ignore malformed events so an OBS source keeps running.
    }
  });
  socket.addEventListener("close", () => {
    setStatus("LOCAL FEED RECONNECTING");
    window.setTimeout(connectLocalSocket, 3000);
  });
  socket.addEventListener("error", () => socket.close());
}

function handleEvent(message) {
  const type = message.type || "";
  const payload = message.payload || message.data || {};
  const targetProfile = payload.profileId || message.profileId;
  if (targetProfile && String(targetProfile) !== String(profileId)) return;

  if (type === "config" && payload.type === overlayType) {
    applyConfig({ ...(payload.config || {}), id: payload.id, name: payload.name });
    return;
  }
  if (overlayType === "alerts" && (
    type === "alerts.test" || type === "alert" || type === "twitch.follow" ||
    type === "twitch.subscription" || type === "twitch.raid" || type === "twitch.tip"
  )) {
    const eventType = payload.eventType || payload.event || type.split(".")[1] || "follow";
    enqueueAlert({ ...payload, headline: payload.headline || payload.title, eventType });
  }
  if (overlayType === "reactives" && (
    type === "reactives.test" || type === "reactives" || type === "reactive.speaking" || type === "discord.voice" || type === "discord.speaking"
  )) setSpeaking(payload);
  if (overlayType === "timer" && (type === "timer.state" || type === "timer" || type === "timer.test")) updateTimerState(payload);
  if (overlayType === "spotify" && (type === "spotify.status" || type === "spotify.track" || type === "spotify" || type === "spotify.test")) updateSpotify(payload);
}

async function loadLiveState() {
  if (overlayType === "timer") {
    try {
      updateTimerState(await getJson(`/api/public/timer/${encodeURIComponent(profileId)}`));
    } catch {
      timerState.remainingSeconds = Number(config.startingSeconds) || 0;
      timerState.updatedAt = Date.now();
      renderTimer();
    }
    window.setInterval(renderTimer, 1000);
  }
  if (overlayType === "spotify") {
    try {
      updateSpotify(await getJson("/api/public/spotify/now-playing"));
    } catch {
      renderSpotify();
    }
    window.clearInterval(progressInterval);
    progressInterval = window.setInterval(() => updateSpotifyProgress(), 1000);
  }
}

async function init() {
  if (!allowedTypes.has(overlayType)) {
    setStatus("UNKNOWN OVERLAY", "error");
    return;
  }
  document.body.dataset.overlay = overlayType;
  try {
    const data = await getJson(`/api/public/profiles/${encodeURIComponent(overlayType)}/${encodeURIComponent(profileId)}`);
    const profile = data?.profile || data;
    applyConfig({ ...(profile?.config || profile), id: profile?.id, name: profile?.name });
  } catch {
    applyConfig(fallbacks[overlayType]);
  }
  if (overlayType === "chat") connectIrc();
  else connectLocalSocket();
  await loadLiveState();

  if (isPreview) {
    if (overlayType === "chat") {
      appendChatMessage({ user: "PixelPilot", message: "Podcast night is looking sharp!", color: "#65a6ff", badges: ["mod"] });
      appendChatMessage({ user: "ForgeViewer", message: "Audio is clear on my side ✨", color: "#ffb454", badges: [] });
    }
    if (overlayType === "alerts") {
      window.setTimeout(() => enqueueAlert({ user: "ForgeViewer", eventType: "follow" }), 250);
    }
  }
  window.parent?.postMessage({ type: "streamforge:overlay-ready", overlayType }, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data) return;
  if (event.data.type === "streamforge:preview" && event.data.overlayType === overlayType) {
    const previousChannel = config.channel;
    applyConfig(event.data.config);
    if (overlayType === "chat" && previousChannel !== config.channel) connectIrc();
  }
  if (event.data.type === "streamforge:event") handleEvent(event.data.event || {});
});

init();
