import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsGitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExecutable =
  process.platform === "win32" && fs.existsSync(windowsGitBash) ? windowsGitBash : "bash";

function bootstrapCommand(relativePath) {
  const text = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const command = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("pkg update -y && pkg install -y git"));
  assert.ok(command, `No Git-only bootstrap command found in ${relativePath}`);
  return command;
}

test("documented bootstrap is Git-only, consistent, and valid Bash", () => {
  const readmeCommand = bootstrapCommand("README.md");
  const termuxCommand = bootstrapCommand(path.join("docs", "TERMUX.md"));

  assert.equal(termuxCommand, readmeCommand);
  assert.doesNotMatch(readmeCommand, /\bcurl\b/);

  const syntax = spawnSync(bashExecutable, ["-n", "-c", readmeCommand], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
