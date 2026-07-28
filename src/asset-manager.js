import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TYPES = new Map([
  ["image/png", { extension: ".png", kind: "image", maxBytes: 8 * 1024 * 1024 }],
  ["image/webp", { extension: ".webp", kind: "image", maxBytes: 8 * 1024 * 1024 }],
  ["image/gif", { extension: ".gif", kind: "image", maxBytes: 8 * 1024 * 1024 }],
  ["audio/mpeg", { extension: ".mp3", kind: "audio", maxBytes: 15 * 1024 * 1024 }],
  ["audio/ogg", { extension: ".ogg", kind: "audio", maxBytes: 15 * 1024 * 1024 }],
  ["audio/wav", { extension: ".wav", kind: "audio", maxBytes: 15 * 1024 * 1024 }],
  ["audio/x-wav", { extension: ".wav", kind: "audio", maxBytes: 15 * 1024 * 1024 }],
]);

function matchesMagic(buffer, mimeType) {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/webp") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/gif") {
    return ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"));
  }
  if (mimeType === "audio/mpeg") {
    return buffer.subarray(0, 3).toString("ascii") === "ID3" ||
      (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  if (mimeType === "audio/ogg") return buffer.subarray(0, 4).toString("ascii") === "OggS";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WAVE";
  }
  return false;
}

function safeOriginalName(value) {
  return path.basename(String(value || "asset"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .trim()
    .slice(0, 120) || "asset";
}

function decodeUpload(data, declaredMime) {
  if (typeof data !== "string" || !data) throw Object.assign(new Error("Asset data is required."), { statusCode: 400 });
  let encoded = data;
  const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match) {
    if (match[1].toLowerCase() !== declaredMime) {
      throw Object.assign(new Error("Data URL MIME type does not match the declared MIME type."), { statusCode: 400 });
    }
    encoded = match[2];
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw Object.assign(new Error("Asset data must be valid base64."), { statusCode: 400 });
  }
  return Buffer.from(encoded, "base64");
}

export class AssetManager {
  constructor({ dataDir }) {
    this.uploadDir = path.join(dataDir, "uploads");
    this.indexFile = path.join(this.uploadDir, "assets.json");
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.uploadDir, { recursive: true, mode: 0o700 });
  }

  async list() {
    await this.initialize();
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  save(input) {
    const operation = this.writeQueue.then(() => this.saveNow(input));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveNow({ name, mimeType, data }) {
    await this.initialize();
    const normalizedMime = String(mimeType || "").trim().toLowerCase();
    const type = TYPES.get(normalizedMime);
    if (!type) {
      throw Object.assign(new Error("Unsupported asset type."), { statusCode: 415 });
    }
    const buffer = decodeUpload(data, normalizedMime);
    if (!buffer.length) throw Object.assign(new Error("Asset is empty."), { statusCode: 400 });
    if (buffer.length > type.maxBytes) {
      throw Object.assign(new Error(`Asset exceeds the ${type.maxBytes} byte limit.`), { statusCode: 413 });
    }
    if (!matchesMagic(buffer, normalizedMime)) {
      throw Object.assign(new Error("Asset content does not match its declared MIME type."), { statusCode: 415 });
    }

    const id = crypto.randomUUID();
    const storedName = `${id}${type.extension}`;
    const createdAt = new Date().toISOString();
    const asset = {
      id,
      name: safeOriginalName(name),
      kind: type.kind,
      mimeType: normalizedMime === "audio/x-wav" ? "audio/wav" : normalizedMime,
      size: buffer.length,
      createdAt,
      url: `/uploads/${storedName}`,
    };
    await fs.writeFile(path.join(this.uploadDir, storedName), buffer, { mode: 0o600, flag: "wx" });
    try {
      const assets = await this.list();
      assets.push(asset);
      const temporary = `${this.indexFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(assets, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.indexFile);
    } catch (error) {
      await fs.unlink(path.join(this.uploadDir, storedName)).catch(() => {});
      throw error;
    }
    return asset;
  }

  async resolveUrl(pathname) {
    const match = pathname.match(/^\/uploads\/([0-9a-f-]{36}\.(?:png|webp|gif|mp3|ogg|wav))$/i);
    if (!match) return null;
    const assets = await this.list();
    const asset = assets.find((candidate) => candidate.url === `/uploads/${match[1]}`);
    if (!asset) return null;
    return { asset, filePath: path.join(this.uploadDir, match[1]) };
  }
}

export const ASSET_UPLOAD_JSON_LIMIT = 21 * 1024 * 1024;
