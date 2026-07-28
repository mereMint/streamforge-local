import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX_LOG_TAIL_BYTES = 256 * 1024;
const SERVICE_PRESETS = Object.freeze([
  Object.freeze({
    id: "node-helper",
    name: "Node.js helper",
    description: "Run one local Node.js helper script without a shell.",
    command: "node",
    args: ["worker.js"],
    cwd: ".",
    autostart: false,
    enabled: false,
  }),
  Object.freeze({
    id: "rclone-readonly-local",
    name: "Rclone read-only local server",
    description: "Serve a configured rclone remote on localhost only; replace remote: before enabling.",
    command: "rclone",
    args: ["serve", "http", "remote:", "--addr", "127.0.0.1:8090", "--read-only"],
    cwd: ".",
    autostart: false,
    enabled: false,
  }),
]);

function inputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateSpec(input) {
  const spec = {
    id: String(input.id || "").trim(),
    name: String(input.name || input.id || "").trim().slice(0, 80),
    command: String(input.command || "").trim(),
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    cwd: input.cwd ? String(input.cwd) : null,
    autostart: Boolean(input.autostart),
    enabled: input.enabled !== false,
  };
  if (!ID_PATTERN.test(spec.id)) throw inputError("Service id must use lowercase letters, numbers, _ or -.");
  if (!spec.name || /[\r\n\0]/.test(spec.name)) throw inputError("Service name is invalid.");
  if (!spec.command || /[\r\n\0]/.test(spec.command)) throw inputError("Service command is invalid.");
  if (spec.args.length > 32 || spec.args.some((arg) => arg.length > 1000 || /[\0]/.test(arg))) {
    throw inputError("Service arguments are invalid.");
  }
  if (spec.cwd && /[\r\n\0]/.test(spec.cwd)) throw inputError("Service working directory is invalid.");
  return spec;
}

export class ServiceManager {
  constructor({ config, db, onChange = () => {} }) {
    this.config = config;
    this.db = db;
    this.onChange = onChange;
    this.processes = new Map();
    this.history = new Map();
    this.logsDir = path.join(config.dataDir, "logs");
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async list() {
    const specs = await this.db.listServices();
    return specs.map((spec) => ({
      ...spec,
      status: this.statusFor(spec.id),
    }));
  }

  statusFor(id) {
    const running = this.processes.get(id);
    const history = this.history.get(id) || {};
    return running
      ? {
          state: "running",
          pid: running.child.pid,
          startedAt: running.startedAt,
          restarts: running.restarts,
          lastRestartAt: history.lastRestartAt || null,
          lastExit: history.lastExit || null,
          lastError: history.lastError || null,
        }
      : {
          state: history.lastError ? "error" : "stopped",
          pid: null,
          startedAt: null,
          restarts: history.restarts || 0,
          lastRestartAt: history.lastRestartAt || null,
          lastExit: history.lastExit || null,
          lastError: history.lastError || null,
        };
  }

  async save(input) {
    if (!this.config.serviceEditEnabled) {
      throw new Error("Service editing is disabled. Set SERVICE_EDIT_ENABLED=true to allow it.");
    }
    const spec = validateSpec(input);
    const cwd = spec.cwd ? path.resolve(this.config.repoRoot, spec.cwd) : this.config.repoRoot;
    let cwdStat;
    try {
      cwdStat = fs.statSync(cwd);
    } catch {
      throw inputError("Service working directory does not exist.");
    }
    if (!cwdStat.isDirectory()) throw inputError("Service working directory must be a directory.");
    await this.db.saveService(spec);
    this.onChange();
    return spec;
  }

  async remove(id) {
    if (!this.config.serviceEditEnabled) throw new Error("Service editing is disabled.");
    if (this.processes.has(id)) throw new Error("Stop the service before deleting it.");
    await this.db.deleteService(id);
    this.onChange();
  }

  rotateLog(logPath) {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < 5 * 1024 * 1024) return;
      const previous = `${logPath}.1`;
      fs.rmSync(previous, { force: true });
      fs.renameSync(logPath, previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async start(id, { restartCount = 0 } = {}) {
    if (this.processes.has(id)) return this.statusFor(id);
    const spec = (await this.db.listServices()).find((item) => item.id === id);
    if (!spec) throw new Error(`Unknown service: ${id}`);
    if (!spec.enabled) throw new Error(`Service is disabled: ${id}`);
    const cwd = spec.cwd ? path.resolve(this.config.repoRoot, spec.cwd) : this.config.repoRoot;
    let cwdStat;
    try {
      cwdStat = fs.statSync(cwd);
    } catch {
      throw inputError("Service working directory does not exist.");
    }
    if (!cwdStat.isDirectory()) throw inputError("Service working directory must be a directory.");

    const logPath = path.join(this.logsDir, `${id}.log`);
    this.rotateLog(logPath);
    const log = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    await new Promise((resolve, reject) => {
      log.once("open", resolve);
      log.once("error", reject);
    });
    log.write(`\n[${new Date().toISOString()}] starting ${spec.name}\n`);
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env: process.env,
        shell: false,
        detached: false,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } catch (error) {
      log.end(`[${new Date().toISOString()}] failed: ${error.message}\n`);
      this.history.set(id, {
        ...(this.history.get(id) || {}),
        restarts: restartCount,
        lastError: { message: error.message, at: new Date().toISOString() },
      });
      throw error;
    }
    const record = {
      child,
      log,
      spec,
      restarts: restartCount,
      startedAt: new Date().toISOString(),
      stopping: false,
    };
    this.processes.set(id, record);
    this.onChange();

    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
      log.write(`[${new Date().toISOString()}] failed: ${error.message}\n`);
      this.history.set(id, {
        ...(this.history.get(id) || {}),
        restarts: record.restarts,
        lastError: { message: error.message, at: new Date().toISOString() },
      });
    });
    child.once("close", (code, signal) => {
      if (!spawnError) {
        log.write(
          `[${new Date().toISOString()}] exited code=${code ?? "-"} signal=${signal ?? "-"}\n`,
        );
      }
      log.end();
      const previous = this.history.get(id) || {};
      this.history.set(id, {
        ...previous,
        restarts: record.restarts,
        lastExit: {
          code,
          signal,
          at: new Date().toISOString(),
          expected: record.stopping,
        },
        lastError: spawnError
          ? previous.lastError
          : code && !record.stopping
            ? { message: `Process exited with code ${code}.`, at: new Date().toISOString() }
            : null,
      });
      if (this.processes.get(id) === record) this.processes.delete(id);
      this.onChange();
    });
    return this.statusFor(id);
  }

  async stop(id) {
    const record = this.processes.get(id);
    if (!record) return this.statusFor(id);
    record.stopping = true;
    record.child.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (this.processes.get(id) === record) record.child.kill("SIGKILL");
    }, 5000);
    forceTimer.unref();
    await new Promise((resolve) => {
      if (record.child.exitCode !== null || record.child.signalCode !== null) {
        resolve();
      } else {
        record.child.once("close", resolve);
      }
    });
    clearTimeout(forceTimer);
    return this.statusFor(id);
  }

  async restart(id) {
    const previous = this.processes.get(id)?.restarts || this.history.get(id)?.restarts || 0;
    await this.stop(id);
    this.history.set(id, {
      ...(this.history.get(id) || {}),
      restarts: previous + 1,
      lastRestartAt: new Date().toISOString(),
    });
    return this.start(id, { restartCount: previous + 1 });
  }

  presets() {
    return SERVICE_PRESETS.map((preset) => ({ ...preset, args: [...preset.args] }));
  }

  async tailLogs(id, { maxBytes = 64 * 1024 } = {}) {
    if (!ID_PATTERN.test(String(id))) throw inputError("Service id is invalid.");
    const requestedBytes = Number(maxBytes);
    if (!Number.isInteger(requestedBytes) || requestedBytes < 1 || requestedBytes > MAX_LOG_TAIL_BYTES) {
      throw inputError(`Log tail size must be between 1 and ${MAX_LOG_TAIL_BYTES} bytes.`);
    }
    const logPath = path.join(this.logsDir, `${id}.log`);
    let handle;
    try {
      handle = await fs.promises.open(logPath, "r");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { id, text: "", bytes: 0, truncated: false, updatedAt: null };
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      const bytes = Math.min(stat.size, requestedBytes);
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, stat.size - bytes);
      return {
        id,
        text: buffer.toString("utf8"),
        bytes,
        truncated: stat.size > bytes,
        updatedAt: stat.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async action(id, action) {
    if (action === "start") return this.start(id);
    if (action === "stop") return this.stop(id);
    if (action === "restart") return this.restart(id);
    throw new Error(`Unsupported service action: ${action}`);
  }

  async startAutostart() {
    for (const spec of await this.db.listServices()) {
      if (spec.autostart && spec.enabled) {
        try {
          await this.start(spec.id);
        } catch (error) {
          console.error(`[services] Could not autostart ${spec.id}:`, error.message);
        }
      }
    }
  }

  async stopAll() {
    await Promise.allSettled([...this.processes.keys()].map((id) => this.stop(id)));
  }
}

export { validateSpec };
