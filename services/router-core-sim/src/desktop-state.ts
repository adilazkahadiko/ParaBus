import type { RouterSnapshot } from "../../../packages/shared-types/src/index.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { DiscordIngestServer } from "./discord-ingest.ts";
import { operatorFacingSnapshot } from "./operator-sanitize.ts";
import { OperatorHealthTracker } from "./operator-health.ts";

export interface DesktopStateSources {
  control: Pick<ControlPlane, "snapshot">;
  ingest: Pick<DiscordIngestServer, "snapshot">;
  extras: () => Pick<RouterSnapshot, "userProfiles" | "userSessions" | "system" | "runtimeInfo" | "audioTiming" | "audioRuntimeTiming" | "coreOwnership" | "programAudioShadow" | "rustManagement">;
}

// The wrapper is recreated for each server call; the ingest producer is stable across WS, GET and commands.
// Weak keys isolate independent runtimes/tests without retaining a closed producer.
const healthTrackers = new WeakMap<DesktopStateSources["ingest"], OperatorHealthTracker>();

/** Shared by production delivery and the offline load test; details are opt-in. */
export function desktopState(sources: DesktopStateSources, includeHistory = true, includeRxDetails = false) {
  const snapshot = operatorFacingSnapshot({
    ...sources.control.snapshot(includeHistory), ...sources.extras(),
    discord: sources.ingest.snapshot(Date.now(), includeHistory, includeRxDetails),
  });
  let tracker = healthTrackers.get(sources.ingest);
  if (!tracker) { tracker = new OperatorHealthTracker(); healthTrackers.set(sources.ingest, tracker); }
  return { ...snapshot, operatorHealth: tracker.derive(snapshot) };
}
