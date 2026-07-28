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
let spotifyVisibilityTimer = null;
let spotifyIntervalTimer = null;
let lastSpotifyTrackId = null;
let reactiveRoster = new Map();
let emoteMap = new Map();
let emoteRoomId = null;

const fallbacks = {
  chat: {
    channel: "", messageLimit: 20, showBadges: true, fontFamily: "System Sans",
    fontSize: 28, textColor: "#f5f7fb", accentColor: "#37e6b2",
    backgroundColor: "#0b1119", opacity: 82, animation: "rise", layout: "cards",
    fontWeight: 650, lineHeight: 1.35, messageSpacing: 10, messageRadius: 14,
    showTimestamps: false, showTwitchEmotes: true, showBttvEmotes: true,
    showFfzEmotes: true, showSevenTvEmotes: true, emoteScale: 1,
    blockedUsers: "", blockedBots: "", hideCommands: false, ignoredCommands: "",
    blockedWords: ""
  },
  alerts: {
    headline: "{user} just followed!", message: "Welcome to the forge.", duration: 7,
    animation: "impact", exitAnimation: "fade", layout: "badge", textColor: "#ffffff",
    accentColor: "#ffb454", backgroundColor: "#101722", radius: 18,
    fontFamily: "System Sans", position: "center", mediaFit: "cover"
  },
  reactives: {
    width: 1920, height: 1080, backgroundColor: "transparent", participants: [],
    autoAddMembers: true, useDiscordAvatars: true, talkingAnimation: "bounce",
    mutedStyle: "dim", showNames: true
  },
  timer: {
    label: "THE FORGE STAYS LIVE", eventType: "follow", secondsPerEvent: 300,
    startingSeconds: 7200, goal: 50, layout: "industrial", textColor: "#f7fbff",
    accentColor: "#37e6b2", backgroundColor: "#0e151d", fontFamily: "Monospace",
    digitSize: 94, panelOpacity: 92, radius: 18, align: "center",
    showLabel: true, showMeta: true, showProgress: false
  },
  spotify: {
    displayMode: "change", duration: 12, position: "bottom-left", showAlbumArt: true,
    showProgress: true, layout: "card", textColor: "#ffffff",
    accentColor: "#1ed760", backgroundColor: "#121816", intervalMinutes: 5,
    animation: "slide"
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
    Serif: 'Georgia, "Times New Roman", serif',
    Condensed: '"Arial Narrow", "Roboto Condensed", Impact, sans-serif',
    Humanist: '"Trebuchet MS", "Segoe UI", sans-serif',
    Geometric: 'Futura, "Century Gothic", Montserrat, sans-serif'
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
  styles.setProperty("--font-weight", String(Number(config.fontWeight) || 650));
  styles.setProperty("--line-height", String(Number(config.lineHeight) || 1.35));
  styles.setProperty("--message-spacing", `${Number(config.messageSpacing ?? 10)}px`);
  styles.setProperty("--message-radius", `${Number(config.messageRadius ?? 14)}px`);
  styles.setProperty("--emote-scale", String(Number(config.emoteScale) || 1));
  styles.setProperty("--digit-size", `${Number(config.digitSize ?? 94)}px`);
  styles.setProperty("--panel-opacity", String((Number(config.panelOpacity ?? 92)) / 100));
  renderOverlay();
  if (overlayType === "spotify") scheduleSpotifyVisibility(false);
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
  container.dataset.layout = config.layout || "cards";
}

function appendChatMessage(message) {
  const container = root.querySelector(".chat-overlay");
  if (!container || !shouldShowChatMessage(message)) return;
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
  if (config.showTimestamps) {
    const timestamp = document.createElement("time");
    timestamp.className = "chat-time";
    timestamp.dateTime = new Date(message.timestamp || Date.now()).toISOString();
    timestamp.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    author.append(timestamp);
  }
  const text = document.createElement("span");
  text.className = "chat-text";
  text.append(document.createTextNode(" "));
  appendChatContent(text, message);
  item.append(author, text);
  container.append(item);
  const limit = Math.max(2, Math.min(100, Number(config.messageLimit) || 20));
  while (container.children.length > limit) container.firstElementChild.remove();
}

function csvList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function shouldShowChatMessage(message) {
  const username = String(message.username || message.user || "").toLowerCase();
  const text = String(message.message || "");
  if (csvList(config.blockedUsers).includes(username)) return false;
  if (csvList(config.blockedBots).includes(username)) return false;
  const firstToken = text.trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
  if (config.hideCommands && /^[!/.]/.test(firstToken)) return false;
  const ignoredCommands = csvList(config.ignoredCommands);
  if (
    ignoredCommands.some((command) => {
      const normalized = command.replace(/^[!/.]+/, "");
      return firstToken.replace(/^[!/.]+/, "") === normalized;
    })
  ) return false;
  const lowered = text.toLowerCase();
  if (csvList(config.blockedWords).some((word) => lowered.includes(word))) return false;
  return true;
}

function appendChatContent(container, message) {
  const text = String(message.message || "");
  const native = nativeEmoteRanges(message.emotes, text);
  if (config.showTwitchEmotes && native.length) {
    let cursor = 0;
    for (const range of native) {
      if (range.start > cursor) {
        appendThirdPartyText(container, text.slice(cursor, range.start));
      }
      const image = document.createElement("img");
      image.className = "chat-emote";
      image.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(range.id)}/default/dark/2.0`;
      image.alt = text.slice(range.start, range.end + 1);
      image.loading = "eager";
      container.append(image);
      cursor = range.end + 1;
    }
    if (cursor < text.length) appendThirdPartyText(container, text.slice(cursor));
    return;
  }
  appendThirdPartyText(container, text);
}

function nativeEmoteRanges(raw, text) {
  const ranges = [];
  for (const group of String(raw || "").split("/").filter(Boolean)) {
    const [id, values = ""] = group.split(":");
    for (const value of values.split(",").filter(Boolean)) {
      const [start, end] = value.split("-").map(Number);
      if (
        id &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end < text.length
      ) {
        ranges.push({ id, start, end });
      }
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function appendThirdPartyText(container, text) {
  for (const token of String(text).split(/(\s+)/)) {
    const emote = emoteMap.get(token);
    if (!emote || !providerEnabled(emote.provider)) {
      container.append(document.createTextNode(token));
      continue;
    }
    const image = document.createElement("img");
    image.className = `chat-emote chat-emote--${emote.provider}`;
    image.src = emote.url;
    image.alt = token;
    image.loading = "eager";
    container.append(image);
  }
}

function providerEnabled(provider) {
  if (provider === "bttv") return config.showBttvEmotes !== false;
  if (provider === "ffz") return config.showFfzEmotes !== false;
  if (provider === "7tv") return config.showSevenTvEmotes !== false;
  return true;
}

function badgeLabel(value) {
  return String(value).split("/")[0].slice(0, 3).toUpperCase();
}

function renderAlertShell() {
  if (root.querySelector(".alert-overlay")) {
    root.querySelector(".alert-overlay").dataset.position = config.position || "center";
    const card = root.querySelector(".alert-card");
    card.dataset.layout = config.layout || "badge";
    card.dataset.animation = config.animation || "impact";
    card.dataset.exitAnimation = config.exitAnimation || "fade";
    return;
  }
  root.innerHTML = `
    <div class="alert-overlay">
      <article class="alert-card">
        <div class="alert-media" hidden><img alt=""></div>
        <div class="alert-symbol">!</div>
        <div class="alert-copy">
          <span class="alert-kicker">STREAM EVENT</span>
          <h1 class="alert-title"></h1>
          <p class="alert-message"></p>
        </div>
      </article>
    </div>`;
  const card = root.querySelector(".alert-card");
  root.querySelector(".alert-overlay").dataset.position = config.position || "center";
  card.dataset.layout = config.layout || "badge";
  card.dataset.animation = config.animation || "impact";
  card.dataset.exitAnimation = config.exitAnimation || "fade";
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
  const user = payload.user || payload.username || "ForgeViewer";
  const headlineTemplate = payload.headline || config.headline || "{user} just followed!";
  root.querySelector(".alert-title").textContent = headlineTemplate
    .replaceAll("{user}", user)
    .replaceAll("{amount}", String(payload.amount ?? ""))
    .replaceAll("{event}", eventLabel(payload.eventType));
  root.querySelector(".alert-message").textContent = String(payload.message || config.message || "")
    .replaceAll("{user}", user)
    .replaceAll("{amount}", String(payload.amount ?? ""));
  root.querySelector(".alert-kicker").textContent = eventLabel(payload.eventType);
  root.querySelector(".alert-symbol").textContent = eventSymbol(payload.eventType);
  const media = root.querySelector(".alert-media");
  media.hidden = !payload.image;
  if (payload.image) media.querySelector("img").src = payload.image;
  card.classList.remove("is-visible", "is-leaving");
  void card.offsetWidth;
  card.classList.add("is-visible");
  const duration = Math.max(2, Math.min(30, Number(config.duration) || 7)) * 1000;
  alertTimer = window.setTimeout(() => {
    card.classList.add("is-leaving");
    card.classList.remove("is-visible");
    window.setTimeout(showNextAlert, 520);
  }, duration);
}

function eventLabel(type = "follow") {
  const normalized = String(type).replace(/^twitch\./, "");
  return {
    follow: "NEW FOLLOWER",
    subscription: "NEW SUBSCRIPTION",
    subscribe: "NEW SUBSCRIPTION",
    sub: "NEW SUBSCRIPTION",
    resub: "RESUBSCRIPTION",
    "subscription-message": "RESUBSCRIPTION",
    "subscription-gift": "GIFT SUBS",
    giftsub: "GIFT SUBS",
    cheer: "BITS CHEER",
    bits: "BITS CHEER",
    raid: "INCOMING RAID",
    "channel-points": "CHANNEL POINTS",
    redemption: "CHANNEL POINTS",
    "hype-train": "HYPE TRAIN",
    goal: "CHANNEL GOAL",
    poll: "POLL UPDATE",
    prediction: "PREDICTION",
    shoutout: "SHOUTOUT",
    "stream-online": "STREAM ONLINE",
    "stream-offline": "STREAM OFFLINE",
    charity: "CHARITY DONATION",
    tip: "NEW TIP",
    donation: "NEW DONATION",
    merch: "MERCH PURCHASE",
  }[normalized] || normalized.replace(/[._-]+/g, " ").toUpperCase() || "STREAM EVENT";
}

function eventSymbol(type = "follow") {
  type = String(type).replace(/^twitch\./, "");
  if (["subscription-gift", "giftsub"].includes(type)) return "×";
  if (["resub", "subscription-message"].includes(type)) return "↻";
  if (["cheer", "bits"].includes(type)) return "◆";
  if (["channel-points", "redemption"].includes(type)) return "●";
  if (type === "hype-train") return "▲";
  if (type === "goal") return "◎";
  if (type === "charity") return "♥";
  return { follow: "+", subscription: "★", sub: "★", raid: "↗", tip: "$" }[type] || "!";
}

function renderReactiveScene() {
  root.innerHTML = "";
  const scene = document.createElement("div");
  scene.className = "reactive-overlay";
  if (config.backgroundColor && config.backgroundColor !== "transparent") {
    scene.style.backgroundColor = config.backgroundColor;
  }
  const configured = (config.participants || []).map((participant) => {
    const member = reactiveRoster.get(String(participant.discordUserId || ""));
    return { ...member, ...participant, roster: member };
  });
  if (config.autoAddMembers !== false) {
    const knownIds = new Set(configured.map((participant) => String(participant.discordUserId || "")));
    const automatic = [...reactiveRoster.values()].filter(
      (member) => member.userId && !knownIds.has(String(member.userId)),
    );
    automatic.forEach((member, index) => {
      const total = Math.max(1, automatic.length);
      configured.push({
        ...member,
        id: `discord-${member.userId}`,
        discordUserId: member.userId,
        name: member.displayName,
        x: ((index + 1) / (total + 1)) * 100,
        y: 58,
        size: Math.max(18, Math.min(38, 72 / total)),
        roster: member,
      });
    });
  }
  for (const participant of configured) {
    const member = participant.roster || reactiveRoster.get(String(participant.discordUserId || ""));
    const speaking = Boolean(member?.speaking);
    const muted = Boolean(member?.selfMuted || member?.serverMuted);
    const deafened = Boolean(member?.selfDeafened || member?.serverDeafened || member?.suppressed);
    const person = document.createElement("div");
    person.className = "reactive-person";
    person.dataset.participantId = participant.id;
    person.dataset.discordUserId = participant.discordUserId || "";
    person.dataset.talkingAnimation = participant.talkingAnimation || config.talkingAnimation || "bounce";
    person.classList.toggle("is-speaking", speaking);
    person.classList.toggle("is-muted", muted);
    person.classList.toggle("is-deafened", deafened);
    person.classList.toggle(
      "is-hidden-state",
      (muted || deafened) && (participant.mutedStyle || config.mutedStyle) === "hidden",
    );
    person.style.left = `${clamp(participant.x, 0, 100)}%`;
    person.style.top = `${clamp(participant.y, 0, 100)}%`;
    person.style.width = `${clamp(participant.size, 10, 100)}%`;
    const avatarUrl = config.useDiscordAvatars !== false ? member?.avatarUrl || participant.avatarUrl : "";
    const idleUrl = participant.idleUrl || avatarUrl || "";
    const talkingUrl = participant.talkingUrl || idleUrl;
    const mutedUrl = participant.mutedUrl || idleUrl;
    const deafenedUrl = participant.deafenedUrl || mutedUrl || idleUrl;
    const activeUrl = deafened
      ? deafenedUrl
      : muted
        ? mutedUrl
        : speaking
          ? talkingUrl
          : idleUrl;
    if (activeUrl) {
      const image = document.createElement("img");
      image.src = activeUrl;
      image.alt = participant.name || member?.displayName || "Speaker";
      image.dataset.idleUrl = idleUrl;
      image.dataset.talkingUrl = talkingUrl;
      image.dataset.mutedUrl = mutedUrl;
      image.dataset.deafenedUrl = deafenedUrl;
      person.append(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "reactive-placeholder";
      placeholder.textContent = initials(participant.name || member?.displayName || "?");
      person.append(placeholder);
    }
    const label = document.createElement("span");
    label.className = "reactive-name";
    label.hidden = config.showNames === false;
    label.textContent = participant.name || member?.displayName || "Speaker";
    person.append(label);
    scene.append(person);
  }
  root.append(scene);
}

function setSpeaking(payload) {
  if (payload.userId) {
    const existing = reactiveRoster.get(String(payload.userId)) || {};
    reactiveRoster.set(String(payload.userId), { ...existing, ...payload });
  }
  const selector = payload.participantId
    ? `[data-participant-id="${CSS.escape(String(payload.participantId))}"]`
    : `[data-discord-user-id="${CSS.escape(String(payload.discordUserId || payload.userId || ""))}"]`;
  const person = root.querySelector(selector);
  if (!person) {
    if (config.autoAddMembers !== false) renderReactiveScene();
    return;
  }
  const speaking = Boolean(payload.speaking);
  person.classList.toggle("is-speaking", speaking);
  const image = person.querySelector("img");
  if (image) {
    if (payload.selfDeafened || payload.serverDeafened || payload.suppressed) {
      image.src = image.dataset.deafenedUrl || image.dataset.mutedUrl || image.dataset.idleUrl;
    } else if (payload.selfMuted || payload.serverMuted) {
      image.src = image.dataset.mutedUrl || image.dataset.idleUrl;
    } else {
      image.src = speaking ? image.dataset.talkingUrl : image.dataset.idleUrl;
    }
  }
  if (speaking && isPreview) window.setTimeout(() => {
    person.classList.remove("is-speaking");
    if (image) image.src = image.dataset.idleUrl;
  }, 1500);
}

function updateReactiveSnapshot(payload) {
  const next = new Map();
  for (const member of payload.members || []) {
    const previous = reactiveRoster.get(String(member.userId)) || {};
    next.set(String(member.userId), { ...previous, ...member });
  }
  reactiveRoster = next;
  renderReactiveScene();
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
          <div class="timer-progress"><i></i></div>
        </article>
      </div>`;
  }
  const card = root.querySelector(".timer-card");
  card.dataset.layout = config.layout || "industrial";
  card.dataset.align = config.align || "center";
  root.querySelector(".timer-label").hidden = config.showLabel === false;
  root.querySelector(".timer-meta").hidden = config.showMeta === false;
  root.querySelector(".timer-progress").hidden = !config.showProgress;
  root.querySelector(".timer-label").textContent = config.label || "STREAM TIMER";
  root.querySelector(".timer-event").textContent = `+${formatShortDuration(config.secondsPerEvent || 0)} / ${config.eventType || "event"}`;
  root.querySelector(".timer-goal").textContent = `${timerState.eventCount || 0} / ${config.goal || "—"} GOAL`;
  root.querySelector(".timer-digits").textContent = formatClock(currentRemainingSeconds());
  const starting = Math.max(1, Number(config.startingSeconds) || 1);
  const percentage = clamp((currentRemainingSeconds() / starting) * 100, 0, 100);
  root.querySelector(".timer-progress i").style.setProperty("--timer-progress", `${percentage}%`);
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
  const previousCount = Number(timerState.eventCount || 0);
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
  if (Number(timerState.eventCount || 0) > previousCount) {
    const card = root.querySelector(".timer-card");
    card?.classList.remove("is-event");
    void card?.offsetWidth;
    card?.classList.add("is-event");
    window.setTimeout(() => card?.classList.remove("is-event"), 850);
  }
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
  card.dataset.animation = config.animation || "slide";
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

function setSpotifyVisible(visible, replay = false) {
  const card = root.querySelector(".song-card");
  if (!card) return;
  if (replay) {
    card.classList.remove("is-visible");
    void card.offsetWidth;
  }
  card.classList.toggle("is-visible", Boolean(visible));
}

function scheduleSpotifyVisibility(trackChanged = false) {
  window.clearTimeout(spotifyVisibilityTimer);
  window.clearInterval(spotifyIntervalTimer);
  spotifyVisibilityTimer = null;
  spotifyIntervalTimer = null;
  const hasTrack = Boolean(spotifyTrack || isPreview);
  if (!hasTrack) {
    setSpotifyVisible(false);
    return;
  }
  if (config.displayMode === "always") {
    setSpotifyVisible(true, trackChanged);
    return;
  }
  const showBriefly = () => {
    setSpotifyVisible(true, true);
    spotifyVisibilityTimer = window.setTimeout(
      () => setSpotifyVisible(false),
      Math.max(3, Math.min(60, Number(config.duration) || 12)) * 1000,
    );
  };
  if (config.displayMode === "interval") {
    showBriefly();
    spotifyIntervalTimer = window.setInterval(
      showBriefly,
      Math.max(1, Math.min(60, Number(config.intervalMinutes) || 5)) * 60_000,
    );
    return;
  }
  if (trackChanged || isPreview) showBriefly();
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
  const nextId = raw?.id || raw?.uri || raw?.url || raw?.name || raw?.title || null;
  const trackChanged = Boolean(nextId && nextId !== lastSpotifyTrackId);
  lastSpotifyTrackId = nextId;
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
  scheduleSpotifyVisibility(trackChanged);
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
    username: match[2],
    message: match[3],
    color: tags.color || config.accentColor,
    badges: tags.badges ? tags.badges.split(",") : [],
    emotes: tags.emotes || "",
    roomId: tags["room-id"] || "",
    timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
  };
}

async function providerJson(url) {
  const response = await fetch(url, { mode: "cors", cache: "force-cache" });
  if (!response.ok) throw new Error(`Emote provider returned ${response.status}`);
  return response.json();
}

function addBttvEmotes(input) {
  const values = Array.isArray(input)
    ? input
    : [...(input?.channelEmotes || []), ...(input?.sharedEmotes || [])];
  for (const emote of values) {
    if (!emote?.code || !emote?.id) continue;
    emoteMap.set(emote.code, {
      provider: "bttv",
      url: `https://cdn.betterttv.net/emote/${emote.id}/2x`,
    });
  }
}

function addFfzEmotes(input) {
  for (const set of Object.values(input?.sets || {})) {
    for (const emote of set?.emoticons || []) {
      const urls = emote?.urls || {};
      const url = urls["2"] || urls["1"] || Object.values(urls).at(-1);
      if (!emote?.name || !url) continue;
      emoteMap.set(emote.name, {
        provider: "ffz",
        url: String(url).startsWith("//") ? `https:${url}` : url,
      });
    }
  }
}

function addSevenTvEmotes(input) {
  for (const emote of input?.emote_set?.emotes || []) {
    const host = emote?.data?.host;
    const files = host?.files || [];
    const file =
      files.find((candidate) => candidate.name === "2x.webp") ||
      files.find((candidate) => candidate.format === "WEBP") ||
      files[0];
    if (!emote?.name || !host?.url || !file?.name) continue;
    const base = String(host.url).startsWith("//") ? `https:${host.url}` : host.url;
    emoteMap.set(emote.name, {
      provider: "7tv",
      url: `${base}/${file.name}`,
    });
  }
}

async function loadGlobalEmotes() {
  const results = await Promise.allSettled([
    providerJson("https://api.betterttv.net/3/cached/emotes/global"),
    providerJson("https://api.frankerfacez.com/v1/set/global"),
  ]);
  if (results[0].status === "fulfilled") addBttvEmotes(results[0].value);
  if (results[1].status === "fulfilled") addFfzEmotes(results[1].value);
}

async function loadChannelEmotes(roomId) {
  if (!roomId || emoteRoomId === String(roomId)) return;
  emoteRoomId = String(roomId);
  const results = await Promise.allSettled([
    providerJson(`https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(roomId)}`),
    providerJson(`https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(roomId)}`),
    providerJson(`https://7tv.io/v3/users/twitch/${encodeURIComponent(roomId)}`),
  ]);
  if (results[0].status === "fulfilled") addBttvEmotes(results[0].value);
  if (results[1].status === "fulfilled") addFfzEmotes(results[1].value);
  if (results[2].status === "fulfilled") addSevenTvEmotes(results[2].value);
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
    void loadGlobalEmotes();
  });
  socket.addEventListener("message", ({ data }) => {
    for (const line of String(data).split("\r\n")) {
      if (line.startsWith("PING")) socket.send(line.replace("PING", "PONG"));
      const message = parseIrcLine(line);
      if (message) {
        if (message.roomId) void loadChannelEmotes(message.roomId);
        appendChatMessage(message);
      }
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
  if (
    overlayType === "alerts" &&
    (type === "alerts.test" || type === "alert" || type.startsWith("twitch."))
  ) {
    const eventType = payload.eventType || payload.event || type.split(".")[1] || "follow";
    enqueueAlert({ ...payload, headline: payload.headline || payload.title, eventType });
  }
  if (overlayType === "reactives" && type === "discord.voice.snapshot") {
    updateReactiveSnapshot(payload);
  } else if (overlayType === "reactives" && (
    type === "reactives.test" || type === "reactives" || type === "reactive.speaking" ||
    type === "discord.voice" || type === "discord.speaking"
  )) setSpeaking(payload);
  if (overlayType === "timer" && (type === "timer.state" || type === "timer" || type === "timer.test")) updateTimerState(payload);
  if (overlayType === "spotify" && (type === "spotify.status" || type === "spotify.track" || type === "spotify" || type === "spotify.test")) updateSpotify(payload);
}

async function loadLiveState() {
  if (overlayType === "reactives") {
    try {
      updateReactiveSnapshot(
        await getJson(`/api/public/reactives/${encodeURIComponent(profileId)}/state`),
      );
    } catch {
      renderReactiveScene();
    }
  }
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
