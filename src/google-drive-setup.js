import crypto from "node:crypto";
import { spawn } from "node:child_process";

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const REMOTE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SAFE_SCOPES = new Set(["drive.file", "drive"]);

function safeError(message) {
  const text = String(message || "Google Drive setup failed.")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(access_token|refresh_token|client_secret|token|code)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
  return text || "Google Drive setup failed.";
}

export function validatedAuthUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.port !== "53682" ||
      url.pathname !== "/auth"
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractAuthUrl(text) {
  for (const match of String(text).matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const url = validatedAuthUrl(match[0].replace(/[),.;]+$/, ""));
    if (url) return url;
  }
  return null;
}

function parseQuestion(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Rclone returned an invalid configuration response.");
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return {
    state: typeof parsed.State === "string" ? parsed.State : "",
    optionName: typeof parsed.Option?.Name === "string" ? parsed.Option.Name : null,
    error: parsed.Error ? safeError(parsed.Error) : null,
  };
}

export function createRcloneRunner({ executable = "rclone", spawnImpl = spawn } = {}) {
  return ({ args, signal, onOutput = () => {}, timeoutMs = FLOW_TIMEOUT_MS }) =>
    new Promise((resolve, reject) => {
      const child = spawnImpl(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout = `${stdout}${text}`.slice(-64 * 1024);
        onOutput(text);
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr = `${stderr}${text}`.slice(-64 * 1024);
        onOutput(text);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

export class GoogleDriveSetupManager {
  constructor({ runner = createRcloneRunner(), onConnected = async () => {}, timeoutMs = FLOW_TIMEOUT_MS }) {
    this.runner = runner;
    this.onConnected = onConnected;
    this.timeoutMs = timeoutMs;
    this.flow = null;
  }

  publicFlow(flow = this.flow) {
    if (!flow) return null;
    return {
      id: flow.id,
      state: flow.state,
      remoteName: flow.remoteName,
      remotePath: flow.remotePath,
      scope: flow.scope,
      authUrl: flow.state === "awaiting-google" ? flow.authUrl : null,
      createdAt: flow.createdAt,
      expiresAt: flow.expiresAt,
      error: flow.error || null,
    };
  }

  start(input = {}) {
    if (this.flow && !["connected", "failed", "cancelled", "expired"].includes(this.flow.state)) {
      throw Object.assign(new Error("A Google Drive setup is already active."), { statusCode: 409 });
    }
    const remoteName = String(input.remoteName || "streamforge-drive").trim().toLowerCase();
    if (!REMOTE_PATTERN.test(remoteName)) {
      throw Object.assign(new Error("Remote name must use lowercase letters, numbers, _ or -."), { statusCode: 400 });
    }
    const scope = SAFE_SCOPES.has(input.scope) ? input.scope : "drive.file";
    const remotePath = String(input.remotePath || "StreamForge Backups").trim().replace(/^\/+|\/+$/g, "");
    if (!remotePath || remotePath.length > 160 || /[\0\r\n:]/.test(remotePath) || remotePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw Object.assign(new Error("Remote backup path is invalid."), { statusCode: 400 });
    }
    const controller = new AbortController();
    const now = Date.now();
    const flow = {
      id: crypto.randomUUID(),
      state: "starting",
      remoteName,
      remotePath,
      scope,
      authUrl: null,
      error: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
      controller,
    };
    this.flow = flow;
    flow.expiryTimer = setTimeout(() => this.expire(flow), this.timeoutMs);
    flow.expiryTimer.unref?.();
    this.run(flow).catch((error) => {
      if (flow.state === "cancelled" || flow.state === "expired") return;
      flow.state = "failed";
      flow.error = safeError(error.message);
      flow.authUrl = null;
      clearTimeout(flow.expiryTimer);
    });
    return this.publicFlow(flow);
  }

  async step(flow, args, { captureUrl = false } = {}) {
    const result = await this.runner({
      args,
      signal: flow.controller.signal,
      timeoutMs: this.timeoutMs,
      onOutput: captureUrl
        ? (text) => {
            const authUrl = extractAuthUrl(text);
            if (authUrl) {
              flow.authUrl = authUrl;
              flow.state = "awaiting-google";
            }
          }
        : () => {},
    });
    if (result.code !== 0) throw new Error(safeError(result.stderr || "Rclone configuration failed."));
    return parseQuestion(result.stdout);
  }

  baseParameters(flow) {
    // The continuation result answers config_is_local. Supplying that option
    // up front would skip the question and break rclone's state protocol.
    return ["scope", flow.scope];
  }

  async run(flow) {
    let question = await this.step(flow, [
      "config", "create", flow.remoteName, "drive",
      ...this.baseParameters(flow),
      "--non-interactive",
    ]);
    if (question.error) throw new Error(question.error);
    if (question.optionName !== "config_is_local") {
      throw new Error("Rclone did not request the expected local OAuth step.");
    }
    flow.state = "authorizing";
    question = await this.step(flow, [
      "config", "update", flow.remoteName,
      ...this.baseParameters(flow),
      "--non-interactive", "--continue", "--state", question.state, "--result", "true",
    ], { captureUrl: true });
    if (!flow.authUrl) throw new Error("Rclone did not provide a safe local authorization URL.");
    flow.authUrl = null;
    flow.state = "finalizing";
    if (question.error) throw new Error(question.error);
    if (question.state && question.optionName !== "config_team_drive") {
      throw new Error("Rclone returned an unexpected configuration question.");
    }
    if (question.state) {
      question = await this.step(flow, [
        "config", "update", flow.remoteName,
        ...this.baseParameters(flow),
        "--non-interactive", "--continue", "--state", question.state, "--result", "false",
      ]);
      if (question.error || question.state) throw new Error(question.error || "Rclone setup did not complete.");
    }
    flow.state = "verifying";
    const verify = await this.runner({
      args: ["lsd", `${flow.remoteName}:`, "--max-depth", "1"],
      signal: flow.controller.signal,
      timeoutMs: 30_000,
    });
    if (verify.code !== 0) throw new Error("Google Drive authorization completed, but verification failed.");
    await this.onConnected({ remoteName: flow.remoteName, remotePath: flow.remotePath, scope: flow.scope });
    flow.state = "connected";
    clearTimeout(flow.expiryTimer);
  }

  get(id) {
    if (!this.flow || this.flow.id !== id) return null;
    return this.publicFlow();
  }

  cancel(id) {
    if (!this.flow || this.flow.id !== id) return null;
    if (!["connected", "failed", "cancelled", "expired"].includes(this.flow.state)) {
      this.flow.state = "cancelled";
      this.flow.authUrl = null;
      this.flow.controller.abort();
      clearTimeout(this.flow.expiryTimer);
    }
    return this.publicFlow();
  }

  expire(flow) {
    if (this.flow !== flow || ["connected", "failed", "cancelled"].includes(flow.state)) return;
    flow.state = "expired";
    flow.authUrl = null;
    flow.controller.abort();
  }

  stop() {
    if (!this.flow) return null;
    return this.cancel(this.flow.id);
  }
}
