import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { omitNaudiodonCrashHandler, patchNaudiodonSource } from "../scripts/patch-naudiodon.ts";

test("audio binding loads without the optional crash-logging native module", () => {
  const source = `const audio = require('bindings')('naudiodon.node');
var SegfaultHandler = require('segfault-handler');
SegfaultHandler.registerHandler("crash.log");
module.exports = audio;`;
  const patched = omitNaudiodonCrashHandler(source);
  const binding = { AudioIO: true };
  const module = { exports: {} };
  runInNewContext(patched, { module, require(name: string) {
    assert.equal(name, "bindings", "No crash-handler dependency may be loaded");
    return (name: string) => { assert.equal(name, "naudiodon.node"); return binding; };
  } });
  assert.equal(module.exports, binding);
  assert.equal(omitNaudiodonCrashHandler(patched), patched);
  assert.throws(() => omitNaudiodonCrashHandler("unexpected upstream"));
});

test("naudiodon abort passes one argument and completes only after one native stop", async () => {
  const original = `  ioStream.quit = async cb => {
    await audioIOAdon.quit('WAIT');
    if (typeof cb === 'function')
      cb();
  }

  ioStream.abort = cb => {
    audioIOAdon.quit('ABORT', () => {
      if (typeof cb === 'function')
        cb();
    });
  }`;
  const patched = patchNaudiodonSource(original.replaceAll("\n", "\r\n"));
  assert.equal(patchNaudiodonSource(patched), patched, "applying twice is harmless");
  assert.throws(() => patchNaudiodonSource("unexpected upstream"));
  let release!: () => void;
  const stop = new Promise<void>(resolve => { release = resolve; });
  const calls: unknown[][] = [];
  const ioStream = {} as { abort(callback?: () => void): Promise<void>; quit(): Promise<void> };
  runInNewContext(patched, { ioStream, audioIOAdon: { quit(...args: unknown[]) { calls.push(args); return stop; } } });
  let completed = false;
  const abort = ioStream.abort(() => { completed = true; });
  const duplicate = ioStream.quit();
  assert.deepEqual(calls, [["ABORT"]]);
  assert.equal(completed, false);
  release();
  await Promise.all([abort, duplicate]);
  assert.equal(completed, true);
  runInNewContext(patched, { ioStream, audioIOAdon: { quit() { return Promise.reject(new Error("stop failed")); } } });
  await assert.rejects(ioStream.abort(), /stop failed/, "native stop failures remain visible to the caller");
});
