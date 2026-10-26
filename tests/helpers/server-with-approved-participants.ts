import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { AudioChannel, SineSource } from "../../services/router-core-sim/src/audio-engine.ts";
import { ControlPlane } from "../../services/router-core-sim/src/control-plane.ts";
import type { UserSessionSnapshot } from "../../packages/shared-types/src/index.ts";

/** Seed synthetic participants without Discord or audio hardware, then observe real shutdown. */
class SeededControlPlane extends ControlPlane {
  constructor(...args: ConstructorParameters<typeof ControlPlane>) {
    super(...args);
    assert.ok(this.userSessions);
    for (const [id, trusted] of [["910000000000000001", false], ["910000000000000002", true]] as const) {
      const channel = new AudioChannel(`test-participant:${id}`, trusted ? "Trusted Guest" : "Ordinary Guest", "DiscordUser", new SineSource(1000, -6), this.engine.blockSize, this.engine.sampleRate);
      this.userSessions.join(channel, id, "920000000000000001", channel.label);
      this.engine.addChannel(channel);
      if (trusted) assert.equal(this.execute({ type: "SET_USER_TRUSTED", channelId: channel.id, trusted: true, confirmed: true }).ok, true);
      const session: UserSessionSnapshot = this.userSessions.sessions.get(id)!;
      assert.equal(this.execute({ type: "SET_PARTICIPANT_APPROVAL", channelId: channel.id, discordUserId: id, approved: true, expectedSessionGeneration: session.sessionGeneration, expectedApprovalRevision: session.approvalRevision }).ok, true);
    }
  }

  override endParticipantSession(): number {
    const before = [...this.userSessions!.sessions.values()];
    const reset = super.endParticipantSession();
    const after = [...this.userSessions!.sessions.values()].map(session => ({ ...session, gate: this.engine.channels.get(session.currentChannelId!)?.approvalGateOpen }));
    writeFileSync(join(process.env.DBR_SETTINGS_ROOT!, "session-shutdown-proof.json"), JSON.stringify({ before, after, reset }));
    return reset;
  }
}
mock.module("../../services/router-core-sim/src/control-plane.ts", { namedExports: { ControlPlane: SeededControlPlane } });
await import("./server-without-rust.ts");
