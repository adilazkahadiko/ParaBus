import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../services/router-core-sim/public/styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("../services/router-core-sim/src/server.ts", import.meta.url), "utf8");
const ids = (...names: string[]) => { for (const id of names) assert.ok(html.includes(`id="${id}"`), id); };
const commands = (...names: string[]) => { for (const name of names) assert.ok(script.includes(`type: "${name}"`), name); };

test("canonical desktop navigation contains MIX, ROUTE, STATUS, SESSION and SETUP", () => {
  for (const view of ["mix", "route", "status", "session", "setup"]) ids(`show-${view}`, `${view}-view`);
});

test("retained functions remain reachable without retired panels", () => {
  ids("tx-assignment-panel", "recall-safe-panel", "output-test-panel", "extended-diagnostics", "support-bundle");
});

test("desktop safety controls keep nonce auth, emergency epoch and explicit state changes", () => {
  ids("application-control", "emergency-state", "output-guard", "receiver-guard");
  commands("SET_STATE", "EMERGENCY_MUTE", "ACKNOWLEDGE_FAULT");
  assert.match(script, /expectedEmergencyEpoch: snapshot\.emergencyEpoch/); assert.match(script, /dbr-session-nonce/); assert.match(script, /\/ws\?nonce=/);
});

test("MIX preserves banks, vertical faders and always-visible VC masters", () => {
  ids("mix-bank-prev", "mix-bank-next", "mix-bank-label", "participants", "vc-master-list", "mix-search");
  assert.match(script, /const MIX_BANK_SIZE = 16/); assert.match(css, /writing-mode: vertical-lr/);
  commands("SET_VC_SEND", "SET_BUS_MASTER", "SET_BUS_MUTE", "SET_PFL");
});

test("native participant drag stays locked outside SETUP and READY", () => {
  assert.match(script, /addEventListener\("dragstart"/); assert.match(script, /addEventListener\("drop"/);
  assert.match(script, /!\["SETUP", "READY"\]\.includes\(snapshot\.state\)/); assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test("MIX keeps direct strip controls without the retired detail toggle", () => {
  ids("participants", "vc-master-list"); commands("SET_VC_SEND", "SET_PARTICIPANT_APPROVAL");
  assert.ok(!html.includes('id="mix-details"'));
});

test("retained controls use explicit Core commands", () => {
  commands("ACKNOWLEDGE_FAULT", "CLEAR_BUS_OUTPUT", "CLEAR_DIRECT_OUTPUT", "CLEAR_EVENT_LOG", "CONNECT_DISCORD_BOT", "CREATE_VC_BUS", "DELETE_SCENE", "DISCONNECT_DISCORD_BOT", "EMERGENCY_MUTE", "PREVIEW_SCENE", "RECALL_SCENE", "REFRESH_INPUT_DEVICES", "REFRESH_OUTPUT_DEVICES", "REMOVE_VC_BUS", "SAVE_SCENE", "SELECT_INPUT_DEVICE", "SELECT_OUTPUT_DEVICE", "SET_BUS_MASTER", "SET_BUS_MUTE", "SET_BUS_OUTPUT", "SET_CHANNEL_FADER", "SET_CHANNEL_MUTE", "SET_DIRECT_OUTPUT", "SET_OUTPUT_TEST_TONE", "SET_PARTICIPANT_APPROVAL", "SET_PFL", "SET_RECALL_SAFE", "SET_RECEIVER_OWNER", "SET_STATE", "SET_TX_INPUT", "SET_USER_STRIP_ORDER", "SET_VC_SEND", "START_RECORDING", "START_TX", "STOP_RECORDING", "STOP_TX");
});

test("participant order and colors still use persisted Discord identity", () => {
  commands("SET_USER_STRIP_ORDER");
  assert.match(script, /preferredStripPosition/); assert.match(script, /discordUserId/);
});

test("participant approval retains generation and revision safety after detail removal", () => {
  commands("SET_PARTICIPANT_APPROVAL");
  assert.match(script, /expectedSessionGeneration: session\.sessionGeneration/); assert.match(script, /expectedApprovalRevision: session\.approvalRevision/); assert.match(script, /channel\.inputMeter \?\? channel\.meter/);
});

test("Receiver Owner keeps revision-protected manual failover", () => {
  ids("receiver-owner-list"); commands("SET_RECEIVER_OWNER"); assert.match(script, /expectedReceiverGeneration/); assert.match(script, /expectedCurrentOwner/); assert.match(html, /自動切替しません/);
});

test("ROUTE retains participant Direct Out and Bus mapping in the matrix", () => {
  ids("vc-route-list", "tx-assignment-list", "group-bus-members");
  commands("SET_BUS_OUTPUT", "CLEAR_BUS_OUTPUT", "SET_DIRECT_OUTPUT", "CLEAR_DIRECT_OUTPUT", "SET_TX_INPUT");
  assert.match(script, /tap: channel\.directOutput\?\.tap \?\? "PRE"/);
});

test("STATUS keeps diagnostics, searchable event logs and separate Main/Cue health", () => {
  ids("status-io", "status-cue", "status-user-list", "status-bot-list", "status-log-filter", "status-log-level", "status-event-list", "extended-diagnostics-data");
  assert.match(script, /currentSnapshot\.system/); assert.match(script, /currentSnapshot\.programAudioShadow/); assert.match(script, /currentSnapshot\.rustManagement/);
});

test("SETUP retains Tablet administration and complete Bot fields", () => {
  ids("tablet-enabled", "tablet-port", "tablet-pairing-code", "tablet-urls", "bot-profile-list", "add-tx-profile", "add-duplex-profile");
  assert.match(script, /\/api\/tablet\/admin/);
  for (const field of ["id", "label", "role", "token", "guildId", "voiceChannelId", "txAudioMode"]) assert.ok(script.includes(`data-setting="${field}"`), field);
  assert.match(html, /有効化・Port変更は保存して本体を再起動後に反映/);
});

test("SESSION preserves preview-first recall, Recall Safe and selected PRE recording", () => {
  ids("scene-select", "preview-scene", "recall-scene", "recall-safe-list", "recorder-users", "recorder-buses", "recorder-outputs", "start-recording", "stop-recording");
  commands("PREVIEW_SCENE", "RECALL_SCENE", "SET_RECALL_SAFE", "START_RECORDING", "STOP_RECORDING"); assert.match(html, /PRE録音/);
});

test("metering retains Peak, RMS, hold, clip and audio-taper faders", () => {
  assert.match(script, /const FADER_CURVE/); assert.match(script, /function dbToFaderPosition/); assert.match(script, /function faderPositionToDb/);
  assert.match(script, /meter-rms/); assert.match(script, /meter-peak-hold/); assert.match(script, /peak >= 0\.999/); assert.match(html, /input-meter-fill/); assert.doesNotMatch(html, /output-meter-fill/); assert.match(html, /min="-90" max="12"/);
});

test("touch, keyboard and reduced-motion accessibility survive UI removal", () => {
  assert.match(css, /:focus-visible/); assert.match(css, /@media \(pointer: coarse\)/); assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(script, /numberInput\.addEventListener\("keydown"/); assert.match(script, /numberInput\.addEventListener\("blur"/);
});

test("retired panels are removed rather than hidden; endpoint presence API is retained", () => {
  for (const id of ["mix-details", "rust-wasapi-panel", "setup-checklist-panel", "route-selected-details", "vc-bus-management", "direct-output-list", "io-tx-path"]) assert.ok(!html.includes(`id="${id}"`), id);
  assert.doesNotMatch(script, /renderRustManagement|renderSetupChecklist|rustWasapiAction|internalTxPaths/);
  assert.match(script, /fetch\("\/api\/rust\/wasapi"/);
});

test("one canonical desktop UI replaces legacy filenames without changing API routes", () => {
  for (const file of ["minimal.html", "minimal.js", "minimal.css"]) assert.equal(existsSync(new URL(`../services/router-core-sim/public/${file}`, import.meta.url)), false);
  for (const file of ["index.html", "app.js", "styles.css"]) assert.equal(existsSync(new URL(`../services/router-core-sim/public/${file}`, import.meta.url)), true);
  assert.match(server, /url\.pathname === "\/index\.html"/); assert.match(server, /location: "\/"/);
  for (const file of ["tx-mix.js", "support-bundle.js"]) assert.equal(existsSync(new URL(`../services/router-core-sim/public/${file}`, import.meta.url)), true);
});

test("desktop ID selectors resolve to unique canonical HTML elements", () => {
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]); const unique = new Set(all); assert.equal(unique.size, all.length);
  for (const [, id] of script.matchAll(/querySelector\("#([A-Za-z0-9_-]+)"\)/g)) assert.ok(unique.has(id), id);
});
