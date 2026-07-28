import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controller = path.join(repoRoot, "scripts", "streamforge.sh");
const windowsGitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExecutable =
  process.platform === "win32" && fs.existsSync(windowsGitBash) ? windowsGitBash : "bash";
// The lifecycle test relies on Linux PID and /proc semantics. Bash syntax is
// still checked separately on Windows; the full process test runs in Linux CI.
// Maintainers with Git Bash can explicitly opt in to the same process test.
const skipShellLifecycle =
  process.platform === "win32" && process.env.STREAMFORGE_TEST_POSIX !== "1"
    ? "requires Linux PID and /proc semantics"
    : false;

function shellPath(value) {
  if (process.platform !== "win32") return value;
  const normalized = value.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

function runController(projectDir, runtimeDir, nodeBin, args) {
  const controllerArgument = shellPath(controller);
  return spawnSync(bashExecutable, [controllerArgument, ...args], {
    cwd: projectDir,
    env: {
      ...process.env,
      STREAMFORGE_HOME: process.platform === "win32" ? "." : shellPath(projectDir),
      STREAMFORGE_CONTROL_RUNTIME_DIR:
        process.platform === "win32"
          ? shellPath(path.relative(projectDir, runtimeDir))
          : shellPath(runtimeDir),
      STREAMFORGE_NODE_BIN:
        process.platform === "win32"
          ? shellPath(path.relative(projectDir, nodeBin))
          : shellPath(nodeBin),
      STREAMFORGE_SERVICE_MODE: "direct",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("control command documents every lifecycle action", { skip: skipShellLifecycle }, () => {
  const controllerArgument =
    process.platform === "win32" ? "scripts/streamforge.sh" : shellPath(controller);
  const result = spawnSync(bashExecutable, [controllerArgument, "help"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const command of ["run", "start", "stop", "restart", "status", "logs", "doctor"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("controller resolves the project when invoked through a symlink", { skip: skipShellLifecycle }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "streamforge-control-link-"));
  const linkedController = path.join(fixture, "streamforge");
  const fakeNode = path.join(fixture, "fake-node");
  assert.notEqual(
    fs.statSync(controller).mode & 0o111,
    0,
    "the installed controller target must remain executable after Git updates",
  );
  fs.symlinkSync(controller, linkedController);
  fs.writeFileSync(
    fakeNode,
    ["#!/usr/bin/env bash", "printf 'node argument: %s\\n' \"$1\"", ""].join("\n"),
    { mode: 0o700 },
  );

  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const result = spawnSync(bashExecutable, [linkedController, "run"], {
    env: {
      ...process.env,
      STREAMFORGE_NODE_BIN: fakeNode,
      STREAMFORGE_SERVICE_MODE: "direct",
    },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node argument: src\/main\.js/);
});

test("direct fallback starts, logs, and stops a guarded process", { skip: skipShellLifecycle }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "streamforge-control-"));
  const projectDir = path.join(fixture, "project");
  const runtimeDir = path.join(fixture, "runtime");
  const fakeNode = path.join(fixture, "fake-node");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "main.js"), "// fixture\n");
  fs.writeFileSync(path.join(projectDir, "package.json"), "{}\n");
  fs.writeFileSync(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      "printf '%s\\n' 'fake StreamForge ready'",
      "trap 'exit 0' TERM INT",
      "while :; do sleep 1; done",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );

  t.after(() => {
    runController(projectDir, runtimeDir, fakeNode, ["stop"]);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const stopped = runController(projectDir, runtimeDir, fakeNode, ["status"]);
  assert.equal(stopped.status, 3);
  assert.match(stopped.stdout, /not running/);

  const started = runController(projectDir, runtimeDir, fakeNode, ["start"]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.match(started.stdout, /started directly/);
  assert.ok(fs.existsSync(path.join(runtimeDir, "streamforge.pid")));

  const logs = runController(projectDir, runtimeDir, fakeNode, ["logs", "20"]);
  assert.equal(logs.status, 0, logs.stderr);
  assert.match(logs.stdout, /fake StreamForge ready/);

  const stoppedAgain = runController(projectDir, runtimeDir, fakeNode, ["stop"]);
  assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr);
  assert.match(stoppedAgain.stdout, /stopped/);
  assert.equal(fs.existsSync(path.join(runtimeDir, "streamforge.pid")), false);
});
