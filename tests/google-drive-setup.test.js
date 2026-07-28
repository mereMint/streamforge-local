import assert from "node:assert/strict";
import test from "node:test";
import { GoogleDriveSetupManager, validatedAuthUrl } from "../src/google-drive-setup.js";

function waitFor(check, timeout = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error("Timed out"));
      }
    }, 5);
  });
}

test("Drive setup follows question, safe OAuth URL, team drive, verify, and connection", async () => {
  const calls = [];
  let releaseOauth;
  const oauthGate = new Promise((resolve) => { releaseOauth = resolve; });
  const connected = [];
  const runner = async ({ args, onOutput, signal }) => {
    calls.push(args);
    if (args[0] === "lsd") return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--result") && args.at(-1) === "true") {
      onOutput("Open http://evil.example/auth then http://127.0.0.1:53682/auth?state=safe-state\n");
      await oauthGate;
      return {
        code: 0,
        stdout: JSON.stringify({ State: "team-state", Option: { Name: "config_team_drive" } }),
        stderr: "",
      };
    }
    if (args.includes("--result") && args.at(-1) === "false") {
      return { code: 0, stdout: JSON.stringify({ State: "" }), stderr: "" };
    }
    assert.equal(signal.aborted, false);
    return {
      code: 0,
      stdout: JSON.stringify({ State: "oauth-state", Option: { Name: "config_is_local" } }),
      stderr: "",
    };
  };
  const manager = new GoogleDriveSetupManager({
    runner,
    onConnected: async (value) => connected.push(value),
  });
  const started = manager.start({ remoteName: "my-drive", remotePath: "StreamForge", scope: "drive.file" });
  await waitFor(() => manager.get(started.id)?.state === "awaiting-google");
  assert.match(manager.get(started.id).authUrl, /^http:\/\/127\.0\.0\.1:53682\/auth\?/);
  releaseOauth();
  await waitFor(() => manager.get(started.id)?.state === "connected");
  assert.deepEqual(connected, [{ remoteName: "my-drive", remotePath: "StreamForge", scope: "drive.file" }]);
  assert.ok(calls.some((args) => args[0] === "lsd" && args[1] === "my-drive:"));
  assert.deepEqual(calls[0].slice(0, 7), [
    "config", "create", "my-drive", "drive", "scope", "drive.file", "--non-interactive",
  ]);
  assert.equal(calls[0].includes("config_is_local"), false);
  assert.equal(JSON.stringify(manager.get(started.id)).includes("safe-state"), false);
});

test("Drive setup cancellation aborts the owned flow without leaking output", async () => {
  let observedSignal;
  const runner = ({ signal }) => {
    observedSignal = signal;
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "token=secret" })));
  };
  const manager = new GoogleDriveSetupManager({ runner });
  const started = manager.start({ remoteName: "cancel-me" });
  await waitFor(() => Boolean(observedSignal));
  const cancelled = manager.cancel(started.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(observedSignal.aborted, true);
  assert.equal(JSON.stringify(cancelled).includes("secret"), false);
});

test("Drive setup validates remote names, paths, and localhost OAuth URLs", () => {
  const manager = new GoogleDriveSetupManager({ runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.throws(() => manager.start({ remoteName: "../bad" }), /Remote name/);
  assert.throws(() => manager.start({ remoteName: "good", remotePath: "../bad" }), /path/);
  assert.equal(validatedAuthUrl("http://127.0.0.1:53682/auth?state=x")?.includes("state=x"), true);
  assert.equal(validatedAuthUrl("http://192.168.1.2:53682/auth?state=x"), null);
  assert.equal(validatedAuthUrl("http://127.0.0.1:53682/other?state=x"), null);
});
