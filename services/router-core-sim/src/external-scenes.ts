import { randomBytes } from "node:crypto";
import type { SceneValue } from "../../../packages/shared-types/src/index.ts";
import type { ExternalState } from "./external-state.ts";
import { canonical, dependencyKey as dep, fail, fields, textId } from "./external-protocol.ts";

export interface ScenePreview {
  id: string; at: number; sceneId: string; fingerprint: string; keys: string[]; dependencies: string;
}
export class ExternalScenes {
  readonly state: ExternalState; readonly now: () => number;
  constructor(state: ExternalState, now: () => number) { this.state = state; this.now = now; }
  snapshot(sceneId: string) {
    const control = this.state.control, scene = control.scenes.get(sceneId) ?? fail("NOT_FOUND");
    for (const [parameter, value] of Object.entries(scene.values)) {
      const parts = parameter.split(".");
      const supported = parts[0] === "channel" ? parts[2] === "send" ? ["gainDb", "mute"].includes(parts[4])
        : ["order", "label", "faderDb", "mute", "trimDb"].includes(parts[2])
        : parts[0] === "bus" ? ["label", "masterDb", "mute", "compressorEnabled", "compressorThresholdDb", "compressorRatio", "compressorAttackMs",
          "compressorReleaseMs", "compressorMakeupDb", "limiterEnabled", "limiterCeilingDb", "limiterReleaseMs"].includes(parts[2])
          : parts[0] === "matrix" && ["gainDb", "mute"].includes(parts[2]);
      if (!["channel", "bus", "matrix"].includes(parts[0]) || parts.length !== (parts[0] === "channel" && parts[2] === "send" ? 5 : 3)
        || !supported || !control.validSceneValue(parameter, value)) fail("INVALID");
    }
    const changes = control.previewScene(sceneId), excluded = control.excludedSceneParticipantIds(sceneId).sort();
    const keys = [this.state.watch(dep("scene", sceneId), () => {
      const current = control.scenes.get(sceneId); return [this.state.identityOf(current), current?.values];
    })];
    // Bind the scene's actual targets even when all of a target's values currently match.
    const targets = new Set(Object.keys(scene.values).map(parameter => parameter.split(".").slice(0, 2).join(".")));
    for (const target of targets) {
      const [kind, id] = target.split(".");
      if (kind === "channel") keys.push(dep("channel", id));
      if (kind === "bus") keys.push(dep("bus", id));
      if (kind === "matrix") keys.push(this.state.watch(dep("scene-route", sceneId, id), () => this.state.identityOf(control.engine.matrixRoutes.get(id))));
    }
    // Only the diff is watched. A fader absent from the diff must not invalidate confirmation.
    for (const change of changes) {
      const [kind, id, field, busId] = change.parameter.split(".");
      if (kind === "channel") keys.push(dep("channel", id));
      if (kind === "bus") keys.push(dep("bus", id));
      const group = kind === "channel" && field === "faderDb" ? dep("channel", id, "fader")
        : kind === "bus" && field === "masterDb" ? dep("bus", id, "fader")
          : kind === "channel" && field === "send" ? dep("send", id, busId, "fader") : dep("scene-parameter", change.parameter);
      keys.push(this.state.watch(dep("scene-parameter", sceneId, change.parameter), () => {
        const c = kind === "channel" ? control.engine.channels.get(id) : undefined;
        const b = kind === "bus" ? control.engine.buses.get(id) : undefined;
        const r = kind === "matrix" ? control.engine.matrixRoutes.get(id) : undefined;
        return [control.sceneParameterValue(change.parameter), control.recallSafe.has(change.parameter),
          control.sceneParameterLocked(change.parameter, change.to), this.state.identityOf(c ?? b ?? r), c?.currentVoiceChannelId,
          field === "send" ? this.state.identityOf(c?.vcSends.get(busId)) : null];
      }, [group]));
    }
    for (const id of excluded) keys.push(dep("channel", id));
    keys.push(this.state.watch(dep("scene-excluded", sceneId), () => control.scenes.has(sceneId)
      ? control.excludedSceneParticipantIds(sceneId).sort().map(id => [id, this.state.identityOf(control.engine.channels.get(id))]) : null));
    return { changes, excludedParticipantCount: excluded.length, keys,
      fingerprint: canonical([scene.values, changes.map(({ label: _label, ...change }) => change), excluded]) };
  }
  preview(args: unknown, readDisplayNames: boolean) {
    const input = fields(args, ["sceneId"]), sceneId = textId(input.sceneId, 128), snapshot = this.snapshot(sceneId);
    const id = randomBytes(32).toString("base64url");
    const record: ScenePreview = { id, at: this.now(), sceneId, fingerprint: snapshot.fingerprint, keys: snapshot.keys,
      dependencies: this.state.dependencies(snapshot.keys) };
    return { record, data: { previewId: id, sceneId, changes: snapshot.changes.map(change => {
      const [kind, internalId] = change.parameter.split("."), channel = this.state.control.engine.channels.get(internalId);
      const userId = channel?.discordUserId ?? /^discord-user:[^:]+:[^:]+:(\d{17,20})$/.exec(internalId)?.[1];
      const target = kind === "channel" && userId ? { kind: "channel", target: { kind: "user", discordUserId: userId } }
        : kind === "bus" ? { kind: "bus", busId: internalId } : { kind: "other", id: internalId };
      const value = (v: SceneValue | undefined) => !readDisplayNames && change.parameter.endsWith(".label") ? null
        : typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) : v ?? null;
      return { target, field: change.parameter, from: value(change.from), to: value(change.to), recallSafe: change.recallSafe, locked: change.locked };
    }), excludedParticipantCount: snapshot.excludedParticipantCount } };
  }
  check(record: ScenePreview) {
    if (!this.state.control.scenes.has(record.sceneId)) fail("STALE_REVISION");
    const current = this.snapshot(record.sceneId);
    if (current.fingerprint !== record.fingerprint || this.state.dependencies(record.keys) !== record.dependencies) fail("STALE_REVISION");
    return current;
  }
}
