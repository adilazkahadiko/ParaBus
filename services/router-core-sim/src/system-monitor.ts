import { cpus, freemem, networkInterfaces, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import type { SystemMonitorSnapshot } from "../../../packages/shared-types/src/index.ts";

interface CpuTime {
  user: number;
  system: number;
}

export interface SystemMonitorDependencies {
  nowMs?: () => number;
  cpuUsage?: (previous?: CpuTime) => CpuTime;
  memoryUsage?: () => { rss: number; heapUsed: number };
  cpuCount?: () => number;
  freeMemory?: () => number;
  totalMemory?: () => number;
  interfaces?: typeof networkInterfaces;
}

const CACHE_MS = 1_000;

export class SystemMonitor {
  readonly #nowMs: () => number;
  readonly #cpuUsage: (previous?: CpuTime) => CpuTime;
  readonly #memoryUsage: () => { rss: number; heapUsed: number };
  readonly #cpuCount: () => number;
  readonly #freeMemory: () => number;
  readonly #totalMemory: () => number;
  readonly #interfaces: typeof networkInterfaces;
  #lastCpu: CpuTime;
  #lastSampleMs: number;
  #cached: SystemMonitorSnapshot | null = null;

  constructor(dependencies: SystemMonitorDependencies = {}) {
    this.#nowMs = dependencies.nowMs ?? (() => performance.now());
    this.#cpuUsage = dependencies.cpuUsage ?? ((previous) => process.cpuUsage(previous));
    this.#memoryUsage = dependencies.memoryUsage ?? (() => process.memoryUsage());
    this.#cpuCount = dependencies.cpuCount ?? (() => Math.max(1, cpus().length));
    this.#freeMemory = dependencies.freeMemory ?? freemem;
    this.#totalMemory = dependencies.totalMemory ?? totalmem;
    this.#interfaces = dependencies.interfaces ?? networkInterfaces;
    this.#lastCpu = this.#cpuUsage();
    this.#lastSampleMs = this.#nowMs();
  }

  snapshot(): SystemMonitorSnapshot {
    const now = this.#nowMs();
    if (this.#cached && now - this.#lastSampleMs < CACHE_MS) return this.#cached;

    const elapsedMicroseconds = Math.max(1, (now - this.#lastSampleMs) * 1_000);
    const cpu = this.#cpuUsage(this.#lastCpu);
    this.#lastCpu = this.#cpuUsage();
    this.#lastSampleMs = now;
    const memory = this.#memoryUsage();
    const processCpuPercent = Math.min(
      Math.max(1, this.#cpuCount()) * 100,
      Math.max(0, ((cpu.user + cpu.system) / elapsedMicroseconds) * 100),
    );

    const addresses: SystemMonitorSnapshot["networkInterfaces"] = [];
    for (const [name, entries] of Object.entries(this.#interfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4" && entry.family !== "IPv6") continue;
        addresses.push({ name, address: entry.address, family: entry.family, internal: entry.internal });
      }
    }

    this.#cached = {
      processCpuPercent,
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
      systemTotalMemoryBytes: this.#totalMemory(),
      systemFreeMemoryBytes: this.#freeMemory(),
      networkInterfaces: addresses,
    };
    return this.#cached;
  }
}
