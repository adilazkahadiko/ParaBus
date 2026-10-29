import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { AudioEngine } from "../../services/router-core-sim/src/audio-engine.ts";
import { AudioInputManager } from "../../services/router-core-sim/src/audio-input.ts";
import { AudioOutputManager } from "../../services/router-core-sim/src/audio-output.ts";
import { AudioRuntimeTiming } from "../../services/router-core-sim/src/audio-runtime-timing.ts";
import { AudioSchedulerTiming } from "../../services/router-core-sim/src/audio-timing.ts";
import { ControlPlane } from "../../services/router-core-sim/src/control-plane.ts";
import { resolveCoreOwnership } from "../../services/router-core-sim/src/core-ownership.ts";
import { desktopState, type DesktopStateSources } from "../../services/router-core-sim/src/desktop-state.ts";
import { DiscordIngestServer } from "../../services/router-core-sim/src/discord-ingest.ts";
import type { OpusDecoderFactory } from "../../services/router-core-sim/src/opus-decoder.ts";
import { ProgramAudioShadow } from "../../services/router-core-sim/src/program-audio-shadow.ts";
import { RecorderManager } from "../../services/router-core-sim/src/recorder.ts";
import { RustManagementBridge } from "../../services/router-core-sim/src/rust-management.ts";
import { SystemMonitor } from "../../services/router-core-sim/src/system-monitor.ts";
import { UserProfileStore } from "../../services/router-core-sim/src/user-profile-store.ts";
import { UserSessionRegistry } from "../../services/router-core-sim/src/user-session-registry.ts";

/** Full production state producers with idle/nonphysical backends, and fresh synthetic settings. */
export function offlineState(factory: OpusDecoderFactory, sourceFactory?: ConstructorParameters<typeof DiscordIngestServer>[6]) {
  mkdirSync(resolve("target"), { recursive: true });
  const root = mkdtempSync(join(resolve("target"), "rx-load-state-"));
  const engine = new AudioEngine(); // Same 64-channel graph configuration as production default.
  const profiles = new UserProfileStore(root), sessions = new UserSessionRegistry(profiles);
  const ingest = new DiscordIngestServer(engine, "offline-never-listen", null, factory, sessions, null, sourceFactory);
  const output = new AudioOutputManager(48000, 480, 64, null), cue = new AudioOutputManager(48000, 480, 2, null);
  const input = new AudioInputManager(engine, null), recorder = new RecorderManager(engine, join(root, "recordings"));
  const control = new ControlPlane(engine, output, ingest, input, recorder, sessions, undefined, cue);
  const runtime = new AudioRuntimeTiming(), scheduler = new AudioSchedulerTiming();
  const system = new SystemMonitor({ interfaces: () => ({}) }); // No local IP addresses in evidence.
  const core = resolveCoreOwnership({ ROUTER_CORE_OWNERSHIP: "typescript" });
  const shadow = new ProgramAudioShadow({ enabled: false, channels: 64 });
  const rust = new RustManagementBridge({ enabled: false });
  const startedAt = new Date().toISOString();
  const sources: DesktopStateSources = { control, ingest, extras: () => ({
    userProfiles: profiles.snapshot(), userSessions: sessions.snapshot(), system: system.snapshot(),
    runtimeInfo: { buildCommit: "c1b2141cacce771a45510e13b73057ede385263a", pcRole: "RX", startedAt },
    audioTiming: scheduler.snapshot(), audioRuntimeTiming: runtime.snapshot(), coreOwnership: core.snapshot,
    programAudioShadow: shadow.snapshot(), rustManagement: rust.snapshot(),
  }) };
  return { engine, ingest, runtime, scheduler, sources,
    state: (details = false) => ({ type: "state", payload: desktopState(sources, true, details) }),
    async close() { runtime.close(); await ingest.close(); await recorder.close(); profiles.flush(); output.stop(); cue.stop(); input.stop(); },
  };
}
