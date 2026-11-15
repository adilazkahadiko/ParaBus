import { mock } from "node:test";

// Isolate command-triggered desktop WS updates from all periodic state/meter sends.
mock.timers.enable({ apis: ["setInterval"] });
await import("./server-without-rust.ts");
