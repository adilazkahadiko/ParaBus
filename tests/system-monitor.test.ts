import assert from "node:assert/strict";
import test from "node:test";
import { SystemMonitor } from "../services/router-core-sim/src/system-monitor.ts";

test("System monitor samples bounded process and host telemetry without MAC addresses", () => {
  let nowMs = 0;
  let delta = { user: 500_000, system: 250_000 };
  const monitor = new SystemMonitor({
    nowMs: () => nowMs,
    cpuUsage: (previous) => previous ? delta : { user: 1_000_000, system: 500_000 },
    memoryUsage: () => ({ rss: 256 * 1024 ** 2, heapUsed: 64 * 1024 ** 2 }),
    cpuCount: () => 4,
    freeMemory: () => 8 * 1024 ** 3,
    totalMemory: () => 32 * 1024 ** 3,
    interfaces: () => ({
      Ethernet: [{ address: "192.0.2.10", netmask: "255.255.255.0", family: "IPv4", mac: "00:11:22:33:44:55", internal: false, cidr: "192.0.2.10/24" }],
    }),
  });

  nowMs = 1_000;
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.processCpuPercent, 75);
  assert.equal(snapshot.processRssBytes, 256 * 1024 ** 2);
  assert.equal(snapshot.processHeapUsedBytes, 64 * 1024 ** 2);
  assert.equal(snapshot.systemFreeMemoryBytes, 8 * 1024 ** 3);
  assert.deepEqual(snapshot.networkInterfaces, [{ name: "Ethernet", address: "192.0.2.10", family: "IPv4", internal: false }]);
  assert.equal("mac" in snapshot.networkInterfaces[0], false);

  delta = { user: 2_000_000, system: 0 };
  nowMs = 1_500;
  assert.strictEqual(monitor.snapshot(), snapshot, "telemetry is cached for one second");
});

test("System monitor caps CPU by the available logical processor count", () => {
  let nowMs = 0;
  const monitor = new SystemMonitor({
    nowMs: () => nowMs,
    cpuUsage: (previous) => previous ? { user: 10_000_000, system: 0 } : { user: 0, system: 0 },
    memoryUsage: () => ({ rss: 1, heapUsed: 1 }),
    cpuCount: () => 2,
    freeMemory: () => 1,
    totalMemory: () => 2,
    interfaces: () => ({}),
  });
  nowMs = 1_000;
  assert.equal(monitor.snapshot().processCpuPercent, 200);
});
