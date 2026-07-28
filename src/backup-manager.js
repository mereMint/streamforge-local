import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

export class BackupManager {
  constructor(config) {
    this.config = config;
    this.active = null;
    this.lastResult = null;
  }

  status() {
    const backupDir = path.join(this.config.dataDir, "backups");
    let items = [];
    try {
      items = fs
        .readdirSync(backupDir)
        .filter((name) => name.endsWith(".tar.gz"))
        .map((name) => {
          const stat = fs.statSync(path.join(backupDir, name));
          return {
            name,
            createdAt: stat.mtime.toISOString(),
            destination: "local",
            sizeBytes: stat.size,
            status: "complete",
          };
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 50);
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("[backup]", error.message);
    }
    return {
      running: Boolean(this.active),
      lastResult: this.lastResult,
      cloudConfigured: Boolean(this.config.rcloneRemote),
      backups: items,
    };
  }

  async run() {
    if (this.active) throw new Error("A backup is already running.");
    const script = path.join(this.config.repoRoot, "scripts", "backup.sh");
    const args = [script];
    if (this.config.rcloneRemote) args.push("--upload", this.config.rcloneRemote);

    const child = spawn("bash", args, {
      cwd: this.config.repoRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-16_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }).finally(() => {
      this.active = null;
    });
    this.lastResult = {
      ok: code === 0,
      at: new Date().toISOString(),
      output: (code === 0 ? stdout : stderr || stdout).trim().slice(-4000),
    };
    if (code !== 0) throw new Error(this.lastResult.output || `Backup exited with code ${code}.`);
    return this.lastResult;
  }

  async test() {
    const backupDir = path.join(this.config.dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.accessSync(backupDir, fs.constants.W_OK);
    if (!this.config.rcloneRemote) {
      return { ok: true, mode: "local", destination: backupDir };
    }
    const child = spawn("rclone", ["lsd", this.config.rcloneRemote, "--max-depth", "1"], {
      cwd: this.config.repoRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(stderr.trim() || `rclone exited with code ${code}.`);
    return { ok: true, mode: "rclone", destination: this.config.rcloneRemote };
  }
}
