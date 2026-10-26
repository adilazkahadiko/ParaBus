import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { AudioOutputManager } from "../services/router-core-sim/src/audio-output.ts";
import { AudioInputManager } from "../services/router-core-sim/src/audio-input.ts";
import { AsioDuplexStream } from "../services/router-core-sim/src/asio-duplex.ts";
import { audioFaultMessage, localAudioFaultDetail } from "../services/router-core-sim/src/audio-fault-diagnostics.ts";
import type { AudioFaultDiagnostic } from "../packages/shared-types/src/index.ts";

class FakeStream extends EventEmitter {
  start() {}
  abort() {}
  write(_buffer: Buffer, callback?: () => void) { callback?.(); return true; }
}
function backend(hostAPIName = "MME") {
  const stream = new FakeStream();
  const inventory = { devices: [{ id: 7, name: "private device name", hostAPIName, maxInputChannels: 2, maxOutputChannels: 2, defaultSampleRate: 48000 }] };
  const audio = { SampleFormatFloat32: 1, getDevices: () => inventory.devices, AudioIO: class { constructor() { return stream; } } } as never;
  return { stream, inventory, audio };
}
for (const target of ["MAIN_OUTPUT", "INPUT"] as const) {
  for (const scenario of ["STREAM_ERROR", "STREAM_ENDED", "DEVICE_UNAVAILABLE", "ASIO_FAULT"] as const) {
    test(`${target} reports ${scenario} at the fault origin with the selected host API`, t => {
      const { stream, inventory, audio } = backend(scenario === "ASIO_FAULT" ? "ASIO" : "MME");
      const engine = new AudioEngine(48000, 480, 2);
      const asio = new AsioDuplexStream(audio);
      const manager = target === "MAIN_OUTPUT" ? new AudioOutputManager(48000, 480, 2, audio, 3600000, null, "linux", asio) : new AudioInputManager(engine, audio, 3600000, null, "linux", asio);
      t.after(() => manager.stop());
      let diagnostic: AudioFaultDiagnostic | undefined;
      manager.onFault = (_id, _reason, detail) => { diagnostic = detail; };
      if (manager instanceof AudioOutputManager) manager.selectDevice("pa:7"); else manager.selectDevice("pa:7", 1);
      if (scenario === "DEVICE_UNAVAILABLE") { inventory.devices = []; manager.refreshDevices(); }
      else stream.emit(scenario === "STREAM_ENDED" ? "close" : "error", new Error("private driver detail"));
      assert.deepEqual(diagnostic, { classification: scenario, hostApi: scenario === "ASIO_FAULT" ? "ASIO" : "MME" });
      assert.equal(manager.snapshot().state, "FAULT");
    });
  }
  test(`${target} distinguishes a missing endpoint from a failed presence provider`, async t => {
    for (const failedProvider of [true, false]) {
      const { audio } = backend("Windows WASAPI");
      const engine = new AudioEngine(48000, 480, 2);
      const direction = target === "MAIN_OUTPUT" ? "render" : "capture";
      const endpoint = { id: "endpoint", name: "private device name", direction, state: "ACTIVE" } as const;
      const presence = {
        isAvailable: () => true,
        cachedEndpoint: () => endpoint,
        async refreshEndpoints() { if (failedProvider) throw new Error("private provider failure"); return []; },
      };
      const manager = target === "MAIN_OUTPUT" ? new AudioOutputManager(48000, 480, 2, audio, 3600000, presence, "win32") : new AudioInputManager(engine, audio, 3600000, presence, "win32");
      t.after(() => manager.stop());
      let diagnostic: AudioFaultDiagnostic | undefined;
      manager.onFault = (_id, _reason, detail) => { diagnostic = detail; };
      if (manager instanceof AudioOutputManager) manager.selectDevice("pa:7", "endpoint"); else manager.selectDevice("pa:7", 1, "endpoint");
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(diagnostic, { classification: failedProvider ? "PRESENCE_PROVIDER_UNAVAILABLE" : "DEVICE_UNAVAILABLE", hostApi: "Windows WASAPI" });
    }
  });
}
test("unknown diagnostic context cannot export a device name or unbounded multiline detail", () => {
  assert.equal(audioFaultMessage("INPUT"), "Audio fault: target=INPUT classification=UNKNOWN hostApi=UNKNOWN");
  assert.equal(audioFaultMessage("MAIN_OUTPUT", { classification: "STREAM_ERROR", hostApi: "private driver name" }), "Audio fault: target=MAIN_OUTPUT classification=STREAM_ERROR hostApi=UNKNOWN");
  const detail = localAudioFaultDetail("private error\r\n\0\u2028" + "x".repeat(2000));
  assert.equal(detail.length, 1024); assert.doesNotMatch(detail, /[\r\n\0\u2028]/);
});
