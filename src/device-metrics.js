import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BATTERY_CACHE_MS = 30_000;

function boundedPercent(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, Number(number.toFixed(1))));
}

export function cpuSnapshot(cpus = os.cpus()) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    const times = cpu?.times || {};
    const values = Object.values(times).map(Number).filter(Number.isFinite);
    idle += Number(times.idle) || 0;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return total > 0 ? { idle, total } : null;
}

export function cpuPercentBetween(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return boundedPercent(((total - idle) / total) * 100);
}

export function diskUsage(stat) {
  const blockSize = Number(stat?.bsize);
  const blocks = Number(stat?.blocks);
  const availableBlocks = Number(stat?.bavail ?? stat?.bfree);
  if (
    !Number.isFinite(blockSize) ||
    !Number.isFinite(blocks) ||
    !Number.isFinite(availableBlocks) ||
    blockSize <= 0 ||
    blocks <= 0
  ) {
    return null;
  }
  const totalBytes = blockSize * blocks;
  const availableBytes = Math.max(0, blockSize * availableBlocks);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    usedBytes,
    totalBytes,
    availableBytes,
    storagePercent: boundedPercent((usedBytes / totalBytes) * 100),
  };
}

function batteryData(input) {
  const percentage = boundedPercent(input?.percentage);
  const temperatureC = Number(input?.temperature);
  return {
    batteryPercent: percentage,
    temperatureC: Number.isFinite(temperatureC) ? temperatureC : null,
    batteryStatus: input?.status ? String(input.status) : null,
    batteryHealth: input?.health ? String(input.health) : null,
    batteryPlugged: input?.plugged ? String(input.plugged) : null,
  };
}

function sysfsTemperature(value) {
  let temperature = Number.parseFloat(value);
  if (!Number.isFinite(temperature)) return null;
  if (Math.abs(temperature) >= 10_000) temperature /= 1_000;
  else if (Math.abs(temperature) >= 100) temperature /= 10;
  return temperature > -50 && temperature < 150
    ? Number(temperature.toFixed(1))
    : null;
}

export function sysfsBatteryData(fsModule = fs) {
  const root = "/sys/class/power_supply/battery";
  const read = (name) => {
    try {
      return String(fsModule.readFileSync(`${root}/${name}`, "utf8")).trim();
    } catch {
      return "";
    }
  };
  const batteryPercent = boundedPercent(read("capacity"));
  const temperatureC = sysfsTemperature(read("temp"));
  const batteryStatus = read("status") || null;
  const batteryHealth = read("health") || null;
  if (
    batteryPercent == null &&
    temperatureC == null &&
    !batteryStatus &&
    !batteryHealth
  ) {
    return null;
  }
  return {
    batteryPercent,
    temperatureC,
    batteryStatus,
    batteryHealth,
    batteryPlugged:
      batteryStatus && /^(charging|full)$/i.test(batteryStatus)
        ? "POWER_SUPPLY"
        : null,
  };
}

function thermalTemperature(fsModule) {
  try {
    const root = "/sys/class/thermal";
    const temperatures = fsModule
      .readdirSync(root)
      .filter((name) => name.startsWith("thermal_zone"))
      .map((name) =>
        Number.parseFloat(
          fsModule.readFileSync(`${root}/${name}/temp`, "utf8").trim(),
        ),
      )
      .filter(Number.isFinite)
      .map((value) => (Math.abs(value) >= 1_000 ? value / 1_000 : value))
      .filter((value) => value > -50 && value < 150);
    return temperatures.length ? Math.max(...temperatures) : null;
  } catch {
    return null;
  }
}

export function createDeviceMetrics({
  dataDir,
  osModule = os,
  fsModule = fs,
  execFileFn = execFileAsync,
  now = () => Date.now(),
  batteryCacheMs = BATTERY_CACHE_MS,
} = {}) {
  let previousCpu = cpuSnapshot(osModule.cpus());
  let cachedBattery = null;
  let batteryCheckedAt = 0;

  async function readBattery() {
    if (now() - batteryCheckedAt < batteryCacheMs && cachedBattery) {
      return cachedBattery;
    }
    batteryCheckedAt = now();
    try {
      const result = await execFileFn("termux-battery-status", [], {
        timeout: 1_500,
        windowsHide: true,
        maxBuffer: 32 * 1024,
      });
      cachedBattery = {
        ok: true,
        ...batteryData(JSON.parse(String(result.stdout || "{}"))),
        reason: null,
      };
    } catch (error) {
      const fallback = sysfsBatteryData(fsModule);
      cachedBattery = fallback
        ? { ok: true, ...fallback, reason: null }
        : {
            ok: false,
            batteryPercent: null,
            temperatureC: null,
            batteryStatus: null,
            batteryHealth: null,
            batteryPlugged: null,
            reason:
              error?.code === "ENOENT"
                ? "Termux:API battery command is not installed."
                : `Battery details unavailable: ${error.message}`,
          };
    }
    return cachedBattery;
  }

  async function collect() {
    const currentCpu = cpuSnapshot(osModule.cpus());
    let loadPercent = cpuPercentBetween(previousCpu, currentCpu);
    previousCpu = currentCpu;
    if (loadPercent == null) {
      const load = Number(osModule.loadavg?.()[0]);
      const cores = Math.max(1, osModule.cpus()?.length || 1);
      if (Number.isFinite(load) && load > 0) {
        loadPercent = boundedPercent((load / cores) * 100);
      }
    }

    let storage = null;
    let storageReason = null;
    try {
      if (typeof fsModule.statfsSync !== "function") {
        storageReason = "Filesystem usage is not supported by this Node runtime.";
      } else {
        storage = diskUsage(fsModule.statfsSync(dataDir));
        if (!storage) storageReason = "Filesystem usage returned invalid values.";
      }
    } catch (error) {
      storageReason = `Filesystem usage unavailable: ${error.message}`;
    }

    const battery = await readBattery();
    const fallbackTemperature = thermalTemperature(fsModule);
    const temperatureC = battery.temperatureC ?? fallbackTemperature;
    const totalMemory = Number(osModule.totalmem?.()) || 0;
    const freeMemory = Number(osModule.freemem?.()) || 0;
    const memoryPercent = totalMemory
      ? boundedPercent(((totalMemory - freeMemory) / totalMemory) * 100)
      : null;

    return {
      loadPercent,
      memoryPercent,
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
      storagePercent: storage?.storagePercent ?? null,
      storage: storage
        ? {
            usedBytes: storage.usedBytes,
            totalBytes: storage.totalBytes,
            availableBytes: storage.availableBytes,
          }
        : null,
      batteryPercent: battery.batteryPercent,
      batteryStatus: battery.batteryStatus,
      batteryHealth: battery.batteryHealth,
      batteryPlugged: battery.batteryPlugged,
      temperatureC,
      availability: {
        cpu: {
          available: loadPercent != null,
          reason: loadPercent == null ? "Waiting for a second CPU sample." : null,
        },
        storage: { available: Boolean(storage), reason: storageReason },
        battery: { available: battery.ok, reason: battery.reason },
        temperature: {
          available: temperatureC != null,
          reason:
            temperatureC == null
              ? battery.reason || "No readable thermal sensor was found."
              : null,
        },
      },
    };
  }

  return { collect };
}

export default createDeviceMetrics;
