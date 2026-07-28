import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PollManager, normalizePollConfig, parsePollVote } from "../src/poll-manager.js";

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor() {
    super();
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(value) { this.sent.push(value); }
  close() { this.emit("close"); }
}

function fixture(durationSeconds = 10) {
  const profile = {
    id: "poll-1",
    type: "poll",
    name: "Choose",
    config: {
      channel: "Example_Channel",
      choices: [{ label: "One", token: "1" }, { label: "Two", token: "2" }],
      durationSeconds,
      allowVoteChanges: true,
    },
  };
  const broadcasts = [];
  return {
    profile,
    broadcasts,
    db: {
      getOverlay: async (type, id) => type === "poll" && id === profile.id ? profile : null,
      saveOverlay: async (saved) => { profile.config = saved.config; },
    },
    hub: { broadcast: (...args) => broadcasts.push(args) },
  };
}

test("poll config is bounded and vote parsing requires an exact normalized token", () => {
  const config = normalizePollConfig({ channel: "#My-Channel", durationSeconds: 99999 });
  assert.equal(config.channel, "mychannel");
  assert.equal(config.durationSeconds, 3600);
  assert.deepEqual(parsePollVote(":Viewer!x PRIVMSG #chan : 1 ", ["1", "2"]), {
    voterId: "viewer",
    choiceIndex: 0,
  });
  assert.equal(parsePollVote(":Viewer!x PRIVMSG #chan :vote 1", ["1", "2"]), null);
});

test("poll votes deduplicate, optionally change, and never persist voter identities", async (context) => {
  FakeSocket.instances = [];
  const setup = fixture();
  const manager = new PollManager({ ...setup, WebSocketImpl: FakeSocket });
  context.after(() => manager.stopAll());
  await manager.start("poll-1");
  assert.equal(await manager.recordVote("poll-1", "alice", 0), true);
  assert.equal(await manager.recordVote("poll-1", "alice", 0), false);
  assert.equal(await manager.recordVote("poll-1", "alice", 1), true);
  assert.deepEqual(setup.profile.config.pollState.counts, [0, 1]);
  assert.doesNotMatch(JSON.stringify(setup.profile), /alice/);
  const publicPoll = await manager.getPublic("poll-1");
  assert.equal(publicPoll.choices[1].percentage, 100);
});

test("poll serializes simultaneous votes from the same viewer", async (context) => {
  FakeSocket.instances = [];
  const setup = fixture();
  const manager = new PollManager({ ...setup, WebSocketImpl: FakeSocket });
  context.after(() => manager.stopAll());
  await manager.start("poll-1");
  const results = await Promise.all([
    manager.recordVote("poll-1", "rapid-viewer", 0),
    manager.recordVote("poll-1", "rapid-viewer", 0),
  ]);
  assert.deepEqual(results, [true, false]);
  const state = await manager.getPublic("poll-1");
  assert.equal(state.totalVotes, 1);
  assert.deepEqual(state.choices.map((choice) => choice.count), [1, 0]);
});

test("poll serializes simultaneous votes from different viewers", async (context) => {
  FakeSocket.instances = [];
  const setup = fixture();
  const manager = new PollManager({ ...setup, WebSocketImpl: FakeSocket });
  context.after(() => manager.stopAll());
  await manager.start("poll-1");
  const results = await Promise.all([
    manager.recordVote("poll-1", "alice", 0),
    manager.recordVote("poll-1", "bob", 1),
    manager.recordVote("poll-1", "charlie", 0),
  ]);
  assert.deepEqual(results, [true, true, true]);
  const state = await manager.getPublic("poll-1");
  assert.equal(state.totalVotes, 3);
  assert.deepEqual(state.choices.map((choice) => choice.count), [2, 1]);
});

test("poll automatically ends after its bounded duration", async () => {
  FakeSocket.instances = [];
  const setup = fixture();
  const manager = new PollManager({ ...setup, WebSocketImpl: FakeSocket });
  await manager.start("poll-1");
  const session = manager.sessions.get("poll-1");
  clearTimeout(session.endTimer);
  session.endTimer = setTimeout(() => manager.end("poll-1"), 15);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.sessions.has("poll-1"), false);
  assert.equal(setup.profile.config.pollState.status, "ended");
  assert.ok(setup.broadcasts.some(([, type]) => type === "poll.ended"));
});

test("an expired persisted poll is shown as ended after a restart", async () => {
  const setup = fixture();
  setup.profile.config.pollState = {
    status: "active",
    counts: [3, 2],
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    endsAt: new Date(Date.now() - 10_000).toISOString(),
    endedAt: null,
  };
  const manager = new PollManager({ ...setup, WebSocketImpl: FakeSocket });
  const state = await manager.getPublic("poll-1");
  assert.equal(state.status, "ended");
  assert.equal(state.remainingMs, 0);
  assert.equal(state.endedAt, setup.profile.config.pollState.endsAt);
});
