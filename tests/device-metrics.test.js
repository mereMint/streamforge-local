import assert from "node:assert/strict";
import test from "node:test";
import {
  cpuPercentBetween,
  createDeviceMetrics,
  diskUsage,
} from "../src/device-metrics.js";

test("device metric helpers calculate bounded CPU and storage usage", () => {
  assert.equal(
    cpuPercentBetween(
      { idle: 500, total: 1_000 },
      { idle: 550, total: 1_200 },
    ),
    75,
  );
  assert.deepEqual(diskUsage({ bsize: 1_000, blocks: 100, bavail: 25 }), {
    usedBytes: 75_000,
    totalBytes: 100_000,
    availableBytes: 25_000,
    storagePercent: 75,
  });
});

test("device metrics expose storage and Termux battery details", async () => {
  let cpuCall = 0;
  const samples = [
    [{ times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }],
    [{ times: { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } }],
  ];
  const metrics = createDeviceMetrics({
    dataDir: "/data",
    osModule: {
      cpus: () => samples[Math.min(cpuCall++, samples.length - 1)],
      loadavg: () => [0, 0, 0],
      totalmem: () => 1_000,
      freemem: () => 250,
    },
    fsModule: {
      statfsSync: () => ({ bsize: 10, blocks: 100, bavail: 40 }),
      readdirSync: () => [],
    },
    execFileFn: async () => ({
      stdout: JSON.stringify({
        percentage: 82,
        temperature: 34.5,
        status: "CHARGING",
        health: "GOOD",
        plugged: "PLUGGED_USB",
      }),
    }),
  });

  const status = await metrics.collect();
  assert.equal(status.loadPercent, 50);
  assert.equal(status.memoryPercent, 75);
  assert.equal(status.storagePercent, 60);
  assert.equal(status.batteryPercent, 82);
  assert.equal(status.temperatureC, 34.5);
  assert.equal(status.availability.battery.available, true);
  assert.equal(status.availability.storage.available, true);
});

test("device metrics report unavailable optional phone sensors explicitly", async () => {
  const metrics = createDeviceMetrics({
    dataDir: "/data",
    osModule: {
      cpus: () => [],
      loadavg: () => [0, 0, 0],
      totalmem: () => 0,
      freemem: () => 0,
    },
    fsModule: {
      statfsSync: () => {
        throw new Error("denied");
      },
      readdirSync: () => {
        throw new Error("denied");
      },
    },
    execFileFn: async () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    },
  });

  const status = await metrics.collect();
  assert.equal(status.batteryPercent, null);
  assert.equal(status.storagePercent, null);
  assert.match(status.availability.battery.reason, /not installed/i);
  assert.match(status.availability.storage.reason, /denied/i);
});
