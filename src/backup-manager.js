import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

export class BackupManager {
  constructor(config) {
    this.config = config;
    this.active = null;
    this.lastResult = null;
    this.preferences = {
      provider: config.rcloneRemote ? "rclone" : "local",
      retention: 10,
      folder: "",
    };
  }

  configure(input = {}) {
    const retention = Number(input.backupRetention ?? input.retention);
    const requestedProvider = String(
      input.backupProvider || input.provider || this.preferences.provider || "local",
    )
      .trim()
      .slice(0, 40);
    const provider = ["local", "rclone", "webdav"].includes(requestedProvider)
      ? requestedProvider
      : this.config.rcloneRemote || input.backupRemote
        ? "rclone"
        : "local";
    this.preferences = {
      provider,
      retention: Number.isFinite(retention)
        ? Math.max(1, Math.min(100, Math.round(retention)))
        : this.preferences.retention,
      folder: String(input.backupFolder || input.folder || this.preferences.folder || "")
        .trim()
        .slice(0, 200),
    };
    return this.publicConfiguration();
  }

  setRcloneRemote(remote) {
    this.config.rcloneRemote = String(remote || "").trim().slice(0, 240) || null;
    return this.publicConfiguration();
  }

  activeRemote() {
    if (
      !this.config.rcloneRemote ||
      !["rclone", "webdav", "google-drive"].includes(this.preferences.provider)
    ) {
      return null;
    }
    const remote = this.config.rcloneRemote.replace(/\/+$/, "");
    const folder = this.preferences.folder.replace(/^\/+|\/+$/g, "");
    if (!folder) return remote;
    const separator = remote.indexOf(":");
    if (separator < 1) return remote;
    const existingPath = remote.slice(separator + 1).replace(/^\/+|\/+$/g, "");
    const normalizedExisting = existingPath.toLocaleLowerCase();
    const normalizedFolder = folder.toLocaleLowerCase();
    if (
      normalizedExisting === normalizedFolder ||
      normalizedExisting.endsWith(`/${normalizedFolder}`)
    ) {
      return remote;
    }
    return `${remote}${existingPath ? "/" : ""}${folder}`;
  }

  publicConfiguration() {
    return {
      ...this.preferences,
      cloudConfigured: Boolean(this.config.rcloneRemote),
      cloudActive: Boolean(this.activeRemote()),
      remoteType: this.config.rcloneRemote ? "rclone" : null,
      contents: [
        "The server .env file, including integration credentials",
        "The StreamForge database and saved overlay profiles",
        "Uploaded images, sounds, service logs, and other DATA_DIR files",
      ],
      exclusions: ["Existing backup archives are excluded to prevent recursive backups"],
    };
  }

  localItems() {
    const backupDir = path.join(this.config.dataDir, "backups");
    try {
      return fs
        .readdirSync(backupDir)
        .filter((name) => /^streamforge-\d{8}T\d{6}Z\.tar\.gz$/.test(name))
        .map((name) => {
          const stat = fs.statSync(path.join(backupDir, name));
          return {
            name,
            createdAt: stat.mtime.toISOString(),
            destination: this.lastResult?.uploadedNames?.includes(name) ? "cloud + local" : "local",
            sizeBytes: stat.size,
            status: "complete",
            checksumPresent: fs.existsSync(path.join(backupDir, `${name}.sha256`)),
          };
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if (error.code !== "ENOENT") console.warn("[backup]", error.message);
      return [];
    }
  }

  status() {
    const allItems = this.localItems();
    return {
      running: Boolean(this.active),
      lastResult: this.lastResult,
      cloudConfigured: Boolean(this.config.rcloneRemote),
      cloudActive: Boolean(this.activeRemote()),
      configuration: this.publicConfiguration(),
      backupCount: allItems.length,
      backups: allItems.slice(0, 50),
    };
  }

  pruneLocal() {
    const backupDir = path.resolve(this.config.dataDir, "backups");
    const items = this.localItems();
    const removed = [];
    for (const item of items.slice(this.preferences.retention)) {
      const archivePath = path.resolve(backupDir, item.name);
      const checksumPath = path.resolve(backupDir, `${item.name}.sha256`);
      if (!archivePath.startsWith(`${backupDir}${path.sep}`)) {
        throw new Error("Refusing to prune a backup outside the backup directory.");
      }
      fs.rmSync(archivePath, { force: true });
      fs.rmSync(checksumPath, { force: true });
      removed.push(item.name);
    }
    return removed;
  }

  async run() {
    if (this.active) throw new Error("A backup is already running.");
    const script = path.join(this.config.repoRoot, "scripts", "backup.sh");
    const args = [script];
    const remote = this.activeRemote();
    if (remote) args.push("--upload", remote);

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
      uploaded: code === 0 && stdout.includes("Cloud backup uploaded successfully."),
    };
    if (code !== 0) throw new Error(this.lastResult.output || `Backup exited with code ${code}.`);
    const archiveMatch = stdout.match(/Local backup created:\s*(.+streamforge-\d{8}T\d{6}Z\.tar\.gz)\s*$/m);
    this.lastResult.uploadedNames =
      this.lastResult.uploaded && archiveMatch ? [path.basename(archiveMatch[1].trim())] : [];
    this.lastResult.pruned = this.pruneLocal();
    return this.lastResult;
  }

  async test() {
    const backupDir = path.join(this.config.dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.accessSync(backupDir, fs.constants.W_OK);
    const remote = this.activeRemote();
    if (!remote) {
      return { ok: true, mode: "local", destination: backupDir };
    }
    const child = spawn("rclone", ["lsd", remote, "--max-depth", "1"], {
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
    return { ok: true, mode: "rclone", destination: remote };
  }
}
