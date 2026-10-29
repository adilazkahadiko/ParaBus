import { isMainThread, parentPort, Worker } from "node:worker_threads";

// Manual simulator only. Network delivery must not inherit the coarse main-thread
// setTimeout being modelled for fill. A sleeping worker wakes the loop via messages;
// no spin loop, timer-resolution setting, native addon, Bot or audio endpoint.
if (!isMainThread) {
  const word = new Int32Array(new SharedArrayBuffer(4));
  parentPort!.on("message", (milliseconds: number) => {
    if (milliseconds > 0) Atomics.wait(word, 0, 0, milliseconds);
    parentPort!.postMessage(null);
  });
}
export class DeliveryWait {
  #worker = new Worker(new URL(import.meta.url));
  #resolve: (() => void) | null = null;
  #reject: ((error: Error) => void) | null = null;
  constructor() {
    this.#worker.on("message", () => { this.#resolve?.(); this.#resolve = null; this.#reject = null; });
    this.#worker.on("error", error => { this.#reject?.(error instanceof Error ? error : new Error(String(error))); });
  }
  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; this.#worker.postMessage(Math.max(0, milliseconds)); });
  }
  async close() { await this.#worker.terminate(); }
}
