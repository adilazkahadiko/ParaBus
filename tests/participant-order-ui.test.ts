import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("canonical UI reorders only online participants with over 113 historical profiles", () => {
  const profiles = Array.from({ length: 200 }, (_, i) => ({ discordUserId: String(700000000000000000n + BigInt(i)), preferredStripPosition: i }));
  const current = { state: "SETUP", userProfiles: profiles, channels: profiles.slice(0, 100).map((profile) => ({ kind: "DiscordUser", discordUserId: profile.discordUserId })), userSessions: [{ discordUserId: profiles[99].discordUserId, online: false }] };
  for (const file of ["app.js"]) {
    const script = readFileSync(new URL(`../services/router-core-sim/public/${file}`, import.meta.url), "utf8");
    const calls: any[] = [];
    const context: any = { state: current, snapshot: current, channelOrder: profiles.slice(0, 100).map((profile) => `discord-user:${profile.discordUserId}`), canReorderChannels: () => current.state === "SETUP", command: (c: any) => calls.push(c), sendCommand: (c: any) => calls.push(c), render() {} };
    const names = ["liveParticipantOrder", "moveParticipant"];
    runInNewContext(names.map((name) => { const start = script.indexOf(`function ${name}(`); return script.slice(start, script.indexOf("\n}", start) + 2); }).join("\n"), context);
    context.moveParticipant(profiles[0].discordUserId, profiles[1].discordUserId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].discordUserIds.length, 99);
    assert.deepEqual(Array.from(calls[0].discordUserIds).slice(0, 2), [profiles[1].discordUserId, profiles[0].discordUserId]);
    assert.equal(calls[0].discordUserIds.includes(profiles[99].discordUserId), false);
    current.state = "ON_AIR";
    context.moveParticipant(profiles[1].discordUserId, profiles[0].discordUserId);
    assert.equal(calls.length, 1);
    current.state = "SETUP";
  }
});

test("desktop participant display follows the server's persisted strip positions", () => {
  const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  const start = script.indexOf("function visibleParticipants(");
  const context: any = { participantSession: () => null };
  runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  const channels = [{ id: "a", kind: "DiscordUser", preferredStripPosition: 1 }, { id: "b", kind: "DiscordUser", preferredStripPosition: 0 }];
  assert.deepEqual(Array.from(context.visibleParticipants({ channels }, null, true), (channel: any) => channel.id), ["b", "a"]);
});
