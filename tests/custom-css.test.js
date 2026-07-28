import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("all six overlay editors expose isolated advanced CSS controls", () => {
  const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "web", "overlay.js"), "utf8");
  assert.equal(html.match(/name="customCss"/g)?.length, 6);
  assert.equal(html.match(/data-reset-custom-css/g)?.length, 6);
  assert.match(runtime, /customOverlayCss/);
  assert.match(runtime, /\.slice\(0, 20_000\)/);
});
