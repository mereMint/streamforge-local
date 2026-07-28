import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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
  if (!ID_PATTERN.test(spec.id)) throw new Error("Service id must use lowercase letters, numbers, _ or -.");
  if (!spec.command || /[\r\n\0]/.test(spec.command)) throw new Error("Service command is invalid.");
  if (spec.args.length > 32 || spec.args.some((arg) => arg.length > 1000 || /[\0]/.test(arg))) {
    throw new Error("Service arguments are invalid.");
  }
  return spec;
}

export class ServiceManager {
  constructor({ config, db, onChange = () => {} }) {
    this.config = config;
    this.db = db;
    this.onChange = onChange;
    this.processes = new Map();
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
    return running
      ? {
          state: "running",
          pid: running.child.pid,
          startedAt: running.startedAt,
          restarts: running.restarts,
        }
      : { state: "stopped", pid: null, startedAt: null, restarts: 0 };
  }

  async save(input) {
    if (!this.config.serviceEditEnabled) {
      throw new Error("Service editing is disabled. Set SERVICE_EDIT_ENABLED=true to allow it.");
    }
    const spec = validateSpec(input);
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
      const cwd = spec.cwd ? path.resolve(this.config.repoRoot, spec.cwd) : this.config.repoRoot;
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
    });
    child.once("close", (code, signal) => {
      if (!spawnError) {
        log.write(
          `[${new Date().toISOString()}] exited code=${code ?? "-"} signal=${signal ?? "-"}\n`,
        );
      }
      log.end();
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
    const previous = this.processes.get(id)?.restarts || 0;
    await this.stop(id);
    return this.start(id, { restartCount: previous + 1 });
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
