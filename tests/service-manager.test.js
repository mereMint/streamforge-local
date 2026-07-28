import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ServiceManager, validateSpec } from "../src/service-manager.js";

test("service specs stay shell-free and bounded", () => {
  const spec = validateSpec({
    id: "music-proxy",
    command: "node",
    args: ["worker.js", "--port", "9000"],
    autostart: true,
  });
  assert.equal(spec.id, "music-proxy");
  assert.deepEqual(spec.args, ["worker.js", "--port", "9000"]);
  assert.equal(spec.autostart, true);
});

test("service specs reject unsafe identifiers and null bytes", () => {
  assert.throws(() => validateSpec({ id: "../bad", command: "node" }));
  assert.throws(() => validateSpec({ id: "good", command: "node\0bad" }));
});

test("service manager starts, restarts, logs, and stops a real process", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-service-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const spec = {
    id: "test-worker",
    name: "Test worker",
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: null,
    autostart: false,
    enabled: true,
  };
  const manager = new ServiceManager({
    config: { dataDir, repoRoot: process.cwd() },
    db: { listServices: async () => [spec] },
  });
  context.after(() => manager.stopAll());

  const started = await manager.start(spec.id);
  assert.equal(started.state, "running");
  assert.ok(started.pid);

  const restarted = await manager.restart(spec.id);
  assert.equal(restarted.state, "running");
  assert.equal(restarted.restarts, 1);
  assert.notEqual(restarted.pid, started.pid);

  const stopped = await manager.stop(spec.id);
  assert.equal(stopped.state, "stopped");
  const log = await fs.readFile(path.join(dataDir, "logs", "test-worker.log"), "utf8");
  assert.match(log, /starting Test worker/);
  assert.match(log, /exited code=/);
});
