import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FONT_FILES = [
  "nunito-latin-wght-normal.woff2",
  "jetbrains-mono-latin-wght-normal.woff2",
  "noto-serif-latin-wght-normal.woff2",
  "roboto-condensed-latin-wght-normal.woff2",
  "source-sans-3-latin-wght-normal.woff2",
  "montserrat-latin-wght-normal.woff2",
];

test("every bundled overlay font is a valid WOFF2 asset referenced by CSS", () => {
  const css = fs.readFileSync(path.join(root, "web", "overlay.css"), "utf8");
  for (const name of FONT_FILES) {
    const file = path.join(root, "web", "fonts", name);
    assert.equal(fs.existsSync(file), true, `${name} should exist`);
    assert.equal(fs.readFileSync(file).subarray(0, 4).toString("ascii"), "wOF2");
    assert.match(css, new RegExp(name.replaceAll(".", "\\.")));
  }
  assert.equal(fs.existsSync(path.join(root, "web", "fonts", "OFL.txt")), true);
});
