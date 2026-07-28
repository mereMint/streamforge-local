import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackupManager } from "../src/backup-manager.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "streamforge-backup-manager-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  return {
    root,
    dataDir,
    manager: new BackupManager({ dataDir, repoRoot: root, rcloneRemote: "" }),
  };
}

test("backup status explains contents and reports checksum coverage", () => {
  const { root, dataDir, manager } = fixture();
  try {
    const name = "streamforge-20260728T120000Z.tar.gz";
    fs.writeFileSync(path.join(dataDir, "backups", name), "archive");
    fs.writeFileSync(path.join(dataDir, "backups", `${name}.sha256`), "checksum");
    const status = manager.status();
    assert.equal(status.cloudConfigured, false);
    assert.equal(status.backups[0].checksumPresent, true);
    assert.match(status.configuration.contents.join(" "), /\.env/);
    assert.match(status.configuration.exclusions.join(" "), /recursive/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup retention only prunes exact local archive pairs", () => {
  const { root, dataDir, manager } = fixture();
  try {
    const names = [
      "streamforge-20260728T120000Z.tar.gz",
      "streamforge-20260728T120100Z.tar.gz",
      "streamforge-20260728T120200Z.tar.gz",
    ];
    names.forEach((name, index) => {
      const archive = path.join(dataDir, "backups", name);
      fs.writeFileSync(archive, `archive-${index}`);
      fs.writeFileSync(`${archive}.sha256`, `checksum-${index}`);
      const timestamp = new Date(Date.UTC(2026, 6, 28, 12, index, 0));
      fs.utimesSync(archive, timestamp, timestamp);
    });
    fs.writeFileSync(path.join(dataDir, "backups", "keep-me.txt"), "safe");
    manager.configure({ backupRetention: 2, backupProvider: "google-drive" });
    assert.equal(manager.publicConfiguration().provider, "local");
    assert.deepEqual(manager.pruneLocal(), [names[0]]);
    assert.equal(fs.existsSync(path.join(dataDir, "backups", names[0])), false);
    assert.equal(fs.existsSync(path.join(dataDir, "backups", `${names[0]}.sha256`)), false);
    assert.equal(fs.existsSync(path.join(dataDir, "backups", "keep-me.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("backup destination honors the selected provider and configured folder", () => {
  const { root, manager } = fixture();
  try {
    manager.setRcloneRemote("streamforge-drive:");
    manager.configure({
      backupProvider: "local",
      backupFolder: "StreamForge Backups",
    });
    assert.equal(manager.activeRemote(), null);
    assert.equal(manager.publicConfiguration().cloudConfigured, true);
    assert.equal(manager.publicConfiguration().cloudActive, false);

    manager.configure({ backupProvider: "rclone" });
    assert.equal(
      manager.activeRemote(),
      "streamforge-drive:StreamForge Backups",
    );

    manager.setRcloneRemote("streamforge-drive:StreamForge Backups");
    assert.equal(
      manager.activeRemote(),
      "streamforge-drive:StreamForge Backups",
      "an existing folder must not be duplicated",
    );
    manager.configure({
      backupProvider: "google-drive",
      backupRemote: "streamforge-drive:",
    });
    assert.equal(
      manager.publicConfiguration().provider,
      "rclone",
      "legacy Google provider values migrate to the rclone option",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
