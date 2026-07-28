import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AssetManager } from "../src/asset-manager.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const SUPPORTED = [
  ["image/webp", "sample.webp", Buffer.from("RIFF0000WEBPdata")],
  ["image/gif", "sample.gif", Buffer.from("GIF89a0000")],
  ["audio/mpeg", "sample.mp3", Buffer.from("ID3audio")],
  ["audio/ogg", "sample.ogg", Buffer.from("OggSaudio")],
  ["audio/wav", "sample.wav", Buffer.from("RIFF0000WAVEdata")],
];

test("asset manager validates, randomizes, persists, and resolves uploads", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-assets-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = new AssetManager({ dataDir });

  const asset = await manager.save({
    name: "../../My avatar?.png",
    mimeType: "image/png",
    data: `data:image/png;base64,${PNG.toString("base64")}`,
  });
  assert.equal(asset.name, "My avatar_.png");
  assert.equal(asset.kind, "image");
  assert.match(asset.url, /^\/uploads\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(await manager.list(), [asset]);

  const resolved = await manager.resolveUrl(asset.url);
  assert.equal((await fs.readFile(resolved.filePath)).equals(PNG), true);
  assert.equal(resolved.asset.mimeType, "image/png");
});

test("asset manager rejects MIME mismatches, malformed base64, and unsupported types", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-assets-invalid-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = new AssetManager({ dataDir });

  await assert.rejects(
    manager.save({ name: "fake.png", mimeType: "image/png", data: Buffer.from("not png").toString("base64") }),
    (error) => error.statusCode === 415,
  );
  await assert.rejects(
    manager.save({ name: "bad.png", mimeType: "image/png", data: "***" }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    manager.save({ name: "svg.svg", mimeType: "image/svg+xml", data: "PHN2Zz4=" }),
    (error) => error.statusCode === 415,
  );
  assert.deepEqual(await manager.list(), []);
});

test("asset manager accepts every documented image and audio format", async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "streamforge-assets-types-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = new AssetManager({ dataDir });

  for (const [mimeType, name, buffer] of SUPPORTED) {
    const asset = await manager.save({ name, mimeType, data: buffer.toString("base64") });
    assert.equal(asset.mimeType, mimeType);
  }
  assert.equal((await manager.list()).length, SUPPORTED.length);
});
