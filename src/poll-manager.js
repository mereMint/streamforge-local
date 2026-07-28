import crypto from "node:crypto";
import WebSocket from "ws";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const MAX_ACTIVE_POLLS = 5;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(maximum, Math.max(minimum, Math.round(number)))
    : fallback;
}

function normalizeToken(value, fallback) {
  return String(value ?? fallback).trim().toLowerCase().slice(0, 32);
}

function normalizeChannel(value) {
  return String(value || "").trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "").slice(0, 25);
}

export function normalizePollConfig(config = {}) {
  const sourceChoices = Array.isArray(config.choices) ? config.choices : [];
  const choices = [0, 1].map((index) => ({
    id: String(sourceChoices[index]?.id || `choice-${index + 1}`).slice(0, 50),
    label: String(sourceChoices[index]?.label || `Option ${index + 1}`).trim().slice(0, 80),
    token: normalizeToken(sourceChoices[index]?.token, String(index + 1)),
  }));
  if (!choices[0].token || !choices[1].token || choices[0].token === choices[1].token) {
    throw Object.assign(new Error("Poll vote tokens must be non-empty and different."), { statusCode: 400 });
  }
  return {
    channel: normalizeChannel(config.channel || config.twitchChannel),
    choices,
    durationSeconds: boundedInteger(config.durationSeconds, 60, 10, 3600),
    allowVoteChanges: config.allowVoteChanges !== false,
  };
}

export function parsePollVote(line, tokens) {
  const match = String(line).match(/^(?:@[^ ]+ )?:([^! ]+)!.* PRIVMSG #[^ ]+ :([\s\S]*)$/);
  if (!match) return null;
  const token = normalizeToken(match[2], "");
  const choiceIndex = tokens.indexOf(token);
  if (choiceIndex === -1) return null;
  return { voterId: match[1].toLowerCase(), choiceIndex };
}

function publicState(id, config, state) {
  const counts = state.counts || [0, 0];
  const total = counts[0] + counts[1];
  const expired =
    state.status === "active" &&
    state.endsAt &&
    new Date(state.endsAt).getTime() <= Date.now();
  const status = expired ? "ended" : state.status || "idle";
  const remainingMs =
    status === "active" && state.endsAt
      ? Math.max(0, new Date(state.endsAt).getTime() - Date.now())
      : 0;
  return {
    id,
    status,
    channel: config.channel,
    choices: config.choices.map((choice, index) => ({
      ...choice,
      count: counts[index] || 0,
      percentage: total ? Math.round(((counts[index] || 0) / total) * 1000) / 10 : 0,
    })),
    totalVotes: total,
    startedAt: state.startedAt || null,
    endsAt: state.endsAt || null,
    endedAt: state.endedAt || (expired ? state.endsAt : null),
    remainingMs,
  };
}

export class PollManager {
  constructor({ db, hub, WebSocketImpl = WebSocket, maxActive = MAX_ACTIVE_POLLS }) {
    this.db = db;
    this.hub = hub;
    this.WebSocketImpl = WebSocketImpl;
    this.maxActive = maxActive;
    this.sessions = new Map();
  }

  async getPublic(id) {
    const profile = await this.db.getOverlay("poll", id);
    if (!profile) return null;
    const config = normalizePollConfig(profile.config);
    return publicState(id, config, profile.config?.pollState || {});
  }

  async persist(session, state) {
    session.state = state;
    await this.db.saveOverlay({
      ...session.profile,
      config: { ...session.profile.config, pollState: state },
    });
    session.profile.config = { ...session.profile.config, pollState: state };
  }

  broadcast(session, type = "poll.state") {
    this.hub.broadcast(`polls:${session.id}`, type, publicState(session.id, session.config, session.state));
  }

  async control(id, action) {
    if (action === "start") return this.start(id);
    if (action === "end") return this.end(id);
    if (action === "reset") return this.reset(id);
    throw Object.assign(new Error("Unsupported poll action."), { statusCode: 400 });
  }

  async start(id) {
    if (this.sessions.has(id)) return publicState(id, this.sessions.get(id).config, this.sessions.get(id).state);
    if (this.sessions.size >= this.maxActive) {
      throw Object.assign(new Error(`At most ${this.maxActive} polls may be active.`), { statusCode: 409 });
    }
    const profile = await this.db.getOverlay("poll", id);
    if (!profile) throw Object.assign(new Error("Poll profile not found."), { statusCode: 404 });
    const config = normalizePollConfig(profile.config);
    if (!config.channel) throw Object.assign(new Error("A Twitch channel is required."), { statusCode: 400 });
    const now = Date.now();
    const session = {
      id,
      profile,
      config,
      voters: new Map(),
      state: {
        status: "active",
        counts: [0, 0],
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + config.durationSeconds * 1000).toISOString(),
        endedAt: null,
      },
      socket: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      voteQueue: Promise.resolve(),
    };
    this.sessions.set(id, session);
    await this.persist(session, session.state);
    this.connect(session);
    session.tickTimer = setInterval(() => this.broadcast(session), 1000);
    session.tickTimer.unref?.();
    session.endTimer = setTimeout(() => this.end(id).catch(() => {}), config.durationSeconds * 1000);
    session.endTimer.unref?.();
    this.broadcast(session, "poll.started");
    return publicState(id, config, session.state);
  }

  connect(session) {
    if (!this.sessions.has(session.id)) return;
    const socket = new this.WebSocketImpl(IRC_URL);
    session.socket = socket;
    let buffer = "";
    socket.on("open", () => {
      session.reconnectAttempts = 0;
      socket.send("PASS SCHMOOPIIE");
      socket.send(`NICK justinfan${crypto.randomInt(10000, 99999)}`);
      socket.send(`JOIN #${session.config.channel}`);
    });
    socket.on("message", (raw) => {
      buffer += raw.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("PING ")) {
          socket.send(line.replace(/^PING/, "PONG"));
          continue;
        }
        const vote = parsePollVote(line, session.config.choices.map((choice) => choice.token));
        if (vote) this.recordVote(session.id, vote.voterId, vote.choiceIndex).catch(() => {});
      }
    });
    const reconnect = () => {
      if (!this.sessions.has(session.id) || session.socket !== socket) return;
      session.socket = null;
      const delay = Math.min(30_000, 1000 * 2 ** session.reconnectAttempts++);
      session.reconnectTimer = setTimeout(() => this.connect(session), delay);
      session.reconnectTimer.unref?.();
    };
    socket.once("close", reconnect);
    socket.once("error", () => {
      try { socket.close(); } catch {}
    });
  }

  recordVote(id, voterId, choiceIndex) {
    const session = this.sessions.get(id);
    if (!session || session.state.status !== "active") return Promise.resolve(false);
    const operation = session.voteQueue.then(() => this.recordVoteNow(id, voterId, choiceIndex));
    session.voteQueue = operation.catch(() => {});
    return operation;
  }

  async recordVoteNow(id, voterId, choiceIndex) {
    const session = this.sessions.get(id);
    if (!session || session.state.status !== "active") return false;
    const previous = session.voters.get(voterId);
    if (previous === choiceIndex || (previous !== undefined && !session.config.allowVoteChanges)) return false;
    const counts = [...session.state.counts];
    if (previous !== undefined) counts[previous] = Math.max(0, counts[previous] - 1);
    counts[choiceIndex] += 1;
    session.voters.set(voterId, choiceIndex);
    await this.persist(session, { ...session.state, counts });
    this.broadcast(session, "poll.vote");
    return true;
  }

  cleanup(session) {
    clearInterval(session.tickTimer);
    clearTimeout(session.endTimer);
    clearTimeout(session.reconnectTimer);
    if (session.socket) {
      session.socket.removeAllListeners();
      try { session.socket.close(); } catch {}
    }
    this.sessions.delete(session.id);
  }

  async end(id) {
    const session = this.sessions.get(id);
    if (!session) {
      const state = await this.getPublic(id);
      if (!state) throw Object.assign(new Error("Poll profile not found."), { statusCode: 404 });
      return state;
    }
    await session.voteQueue.catch(() => {});
    const state = { ...session.state, status: "ended", endedAt: new Date().toISOString() };
    await this.persist(session, state);
    this.broadcast(session, "poll.ended");
    this.cleanup(session);
    return publicState(id, session.config, state);
  }

  async reset(id) {
    const active = this.sessions.get(id);
    if (active) this.cleanup(active);
    const profile = await this.db.getOverlay("poll", id);
    if (!profile) throw Object.assign(new Error("Poll profile not found."), { statusCode: 404 });
    const config = normalizePollConfig(profile.config);
    const state = { status: "idle", counts: [0, 0], startedAt: null, endsAt: null, endedAt: null };
    const session = { id, profile, config, state };
    await this.persist(session, state);
    this.broadcast(session, "poll.reset");
    return publicState(id, config, state);
  }

  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.end(id)));
  }
}
