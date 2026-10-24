import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../services/router-core-sim/src/settings-store.ts";
import { DiscordIngestServer } from "../services/router-core-sim/src/discord-ingest.ts";
import { AudioEngine } from "../services/router-core-sim/src/audio-engine.ts";
import { DiscordFrameType } from "../packages/discord-ipc/src/index.ts";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");

class Element {
  value = ""; textContent = ""; className = ""; innerHTML = "";
  checked = false; disabled = false; hidden = false; open = false;
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  children: Element[] = []; fields = new Map<string, Element>();
  listeners = new Map<string, Array<(event: any) => void>>();
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.textContent = ""; }
  setAttribute() {}
  reportValidity() { return true; }
  querySelector(selector: string) { if (!this.fields.has(selector)) this.fields.set(selector, new Element()); return this.fields.get(selector)!; }
  querySelectorAll() { return this.children; }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
  addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  dispatchEvent(event: any) { for (const fn of this.listeners.get(event.type) ?? []) fn(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click", target: this }); }
}

function ui(names: string[], overrides: any = {}) {
  const commands: any[] = [], notices: string[] = [];
  const elements: Record<string, Element> = new Proxy({} as Record<string, Element>, { get: (target, key: string) => target[key] ??= new Element() });
  const context: any = { elements, snapshot: { state: "SETUP", channels: [], buses: [], discord: { bots: [], txStems: [], availableVoiceChannels: [] } }, settingsSnapshot: { bots: [], tablet: { enabled: false, port: 4174 }, limits: { total: 24 } },
    settingsDirty: false, settingsLoading: false, localSettingsAvailable: true, rustWasapiBusy: false, windowsEndpointInventory: [], setupTestedOutputs: new Set(), botRecoveries: new Map(), document: { createElement: () => new Element(), activeElement: null },
    Option: class extends Element { constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; } }, Event,
    sendCommand: (command: any) => { commands.push(JSON.parse(JSON.stringify(command))); return true; },
    showNotice: (message: string) => notices.push(message), confirm: () => true, desktopJsonHeaders: { "x-dbr-session-nonce": "test" },
    ...overrides,
  };
  const curve = script.match(/const FADER_CURVE = \[[^;]+;/);
  if (curve) runInNewContext(curve[0], context);
  for (const name of names) {
    const marker = script.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
    const start = script.indexOf(marker); assert.ok(start >= 0, name);
    runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  }
  return { context, elements, commands, notices };
}

test("unrelated UI settings save preserves the receiver owner with legacy RX and SPARE after reconnect", (t) => {
  const root = mkdtempSync(join(tmpdir(), "parabus-spare-save-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SettingsStore(root, {});
  store.save({ bots: ["RX", "SPARE"].map((role, i) => ({ id: `RX0${i + 1}`, label: `Receiver ${i}`, role,
    token: `fake-token-${i}`, tokenEnv: `TEST_TOKEN_${i}`, guildId: "100000000000000001", voiceChannelId: "100000000000000002", enabled: true })) });
  const ownership = (bots: ReturnType<SettingsStore["snapshot"]>["bots"]) => {
    const ingest = new DiscordIngestServer(new AudioEngine(48_000, 480, 4), "test-only", null, null);
    for (const [i, bot] of bots.entries()) {
      const botId = String(100000000000000010n + BigInt(i));
      ingest.ingest({ type: DiscordFrameType.BOT_META, botId, userId: botId, guildId: bot.guildId!, voiceChannelId: bot.voiceChannelId!,
        payload: Buffer.from(JSON.stringify({ profileId: bot.id, label: bot.label, role: bot.role, gatewayState: "ready", voiceState: "ready" })) });
    }
    return ingest.snapshot().receiverOwnership[0];
  };
  assert.equal(ownership(store.snapshot().bots).ownerProfileId, "RX01");
  const { context } = ui(["setSelectOptions", "syncControlSelect", "generatedTokenEnvironment", "nextBotProfileId", "updateBotProfileTxFields", "refreshBotProfileLocationOptions", "createBotProfileCard", "botSettingsFromCard"]);
  const bots = store.snapshot().bots.map(bot => context.botSettingsFromCard(context.createBotProfileCard(bot, true)));
  store.save({ bots, tablet: { enabled: false, port: 4175 } });
  const reconnected = ownership(new SettingsStore(root, {}).snapshot().bots);
  assert.equal(reconnected.status, "ACTIVE");
  assert.equal(reconnected.ownerProfileId, "RX01");
});

test("TX matrix assigns and clears Input per Bot without OUT or START commands and locks safely", () => {
  const { context, elements, commands } = ui(["renderTxAssignments", "setTxAssignmentInput", "setSelectOptions", "operateTxAssignment"], {
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 }, txAssignmentSignature: "",
  });
  context.snapshot.input = { state: "READY", selectedDeviceId: "pa:1" };
  context.snapshot.channels = [1, 2, 3].map(index => ({ id: `local-input:${index}`, label: `IN ${index}`, kind: "LocalMonoInput" }));
  const stems = [1, 2].map(index => ({ profileId: `TX${index}`, label: `Team ${index}`, state: "READY", active: false, sourceInputChannelId: null as string | null }));
  context.snapshot.discord.txStems = stems;
  const rows = () => elements.txAssignmentList.children[0].children[1].children;
  const cell = (row: number, col: number) => rows()[row].children[col + 1].children[0];
  context.renderTxAssignments(context.snapshot);
  assert.equal(rows().length, 4, "three input rows plus explicit unassign");
  assert.equal(rows()[1].children.length, 3, "input label plus two TX Bot columns");
  cell(2, 0).click();
  assert.deepEqual(commands, [{ type: "SET_TX_INPUT", profileId: "TX1", channelId: "local-input:2" }]);
  stems[0].sourceInputChannelId = "local-input:2"; context.renderTxAssignments(context.snapshot);
  assert.match(cell(2, 0).className, /assigned/);
  cell(2, 0).click(); assert.deepEqual(commands[1], { type: "SET_TX_INPUT", profileId: "TX1", channelId: null });
  cell(2, 1).click(); assert.deepEqual(commands[2], { type: "SET_TX_INPUT", profileId: "TX2", channelId: "local-input:2" });
  stems[0].active = true; context.renderTxAssignments(context.snapshot);
  cell(1, 0).click(); assert.equal(commands.length, 3);
  stems[0].active = false;
  for (const state of ["ON_AIR", "FAULT"]) {
    context.snapshot.state = state; context.renderTxAssignments(context.snapshot);
    cell(1, 0).click(); context.setTxAssignmentInput("TX1", "local-input:1");
    assert.equal(commands.length, 3);
  }
  context.snapshot.state = "SETUP"; context.socket.readyState = 3; context.renderTxAssignments(context.snapshot);
  assert.equal(cell(1, 0).disabled, true); cell(1, 0).click(); assert.equal(commands.length, 3);
  context.socket.readyState = 1; context.renderTxAssignments(context.snapshot);
  context.confirm = () => false; context.operateTxAssignment("TX1", true); assert.equal(commands.length, 3);
  context.confirm = () => true; context.operateTxAssignment("TX1", true);
  assert.deepEqual(commands[3], { type: "START_TX", profileId: "TX1", confirmed: true });
  assert.equal(commands.some(command => ["SET_DIRECT_OUTPUT", "SET_TX_SOURCE", "SET_VC_SEND"].includes(command.type)), false);
});

test("stereo TX matrix marks L/R together and rejects an incomplete final input pair", () => {
  const { context, elements, commands } = ui(["renderTxAssignments", "setTxAssignmentInput", "setSelectOptions"], {
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 }, txAssignmentSignature: "",
  });
  context.snapshot.channels = [1, 2, 3].map(i => ({ id: `local-input:${i}`, label: `IN ${i}`, kind: "LocalMonoInput" }));
  const stem = { profileId: "TX1", label: "Stereo", state: "READY", active: false, audioMode: "STEREO", sourceInputChannelId: "local-input:1", sourceInputRightChannelId: "local-input:2" };
  context.snapshot.discord.txStems = [stem]; context.renderTxAssignments(context.snapshot);
  const rows = elements.txAssignmentList.children[0].children[1].children;
  assert.equal(rows[1].children[1].children[0].textContent, "L");
  assert.equal(rows[2].children[1].children[0].textContent, "R");
  assert.equal(rows[3].children[1].children[0].disabled, true);
  context.setTxAssignmentInput("TX1", "local-input:3"); assert.equal(commands.length, 0);
  rows[2].children[1].children[0].click();
  assert.deepEqual(commands, [{ type: "SET_TX_INPUT", profileId: "TX1", channelId: null }]);
});

test("remote desktop desktop skips all private API loaders/saves and guards restart without toast storms", async () => {
  let requests = 0;
  const { context, elements, notices } = ui(["loadDesktopSettings", "loadWindowsEndpoints", "saveBotProfiles", "renderRestart"], {
    localSettingsAvailable: false, restartRequested: false,
    fetch: async () => { requests++; throw new Error("remote API must not be called"); },
  });
  await context.loadDesktopSettings(); await context.loadDesktopSettings(true);
  await context.loadWindowsEndpoints(true);
  await context.saveBotProfiles({ preventDefault() {} });
  assert.equal(elements.setupStatus.textContent, "このPCからのみ操作できます");
  context.renderRestart(context.snapshot); assert.equal(elements.restartRouter.disabled, true);
  assert.equal(elements.restartDetail.textContent, "このPCからのみ操作できます");
  assert.equal(requests, 0); assert.equal(notices.length, 0);
});

test("desktop LAN banner stays visible and remote local-only controls stay disabled after meter updates", () => {
  const roots = [new Element(), new Element()];
  const controls = roots.map(root => { const button = new Element(); root.children = [button]; return button; });
  const notes = [new Element(), new Element()], badge = new Element(), status = new Element();
  const { context } = ui(["renderDesktopAccess"], { desktopAccess: { lanEnabled: true, urls: ["http://192.0.2.1:4173"] }, localSettingsAvailable: false,
    document: { body: new Element(), querySelector: (selector: string) => selector === "#lan-access-badge" ? badge : status,
      querySelectorAll: (selector: string) => selector === "[data-local-access-note]" ? notes : roots },
  });
  context.renderDesktopAccess();
  assert.equal(badge.hidden, false); assert.equal(status.textContent, "LAN公開中: http://192.0.2.1:4173");
  assert.equal(notes.every(note => !note.hidden), true); assert.equal(controls.every(control => control.disabled), true);
  controls[0].disabled = false; context.renderDesktopAccess(); assert.equal(controls[0].disabled, true);
  assert.match(html, /id="lan-access-badge"[^>]*hidden>LAN公開中（認証なし）/);
});

test("desktop settings save main settings without editing deferred Tablet preferences", async () => {
  let request: any;
  const { context, elements } = ui(["saveBotProfiles"], { fetch: async (path: string, options: any) => {
    request = { path, ...options };
    return { ok: true, json: async () => ({ ok: true, settings: {} }) };
  }, botSettingsFromCard() {}, renderDesktopSettings() {}, loadTabletAdmin() {} });
  elements.appPort.value = "4173";
  await context.saveBotProfiles({ preventDefault() {} });
  assert.equal(request.path, "/api/settings"); assert.equal(request.method, "POST");
  assert.equal(request.headers["x-dbr-session-nonce"], "test");
  assert.deepEqual(JSON.parse(request.body), { bots: [], operator: { port: 4173, lanAccess: false } });
  assert.doesNotMatch(request.body, /tablet/);
  request = null;
  for (const state of ["ON_AIR", "FAULT"]) {
    context.snapshot.state = state;
    await context.saveBotProfiles({ preventDefault() {} });
    assert.equal(request, null);
  }
});

test("desktop application settings are locked during ON_AIR and FAULT", () => {
  const { context, elements } = ui(["renderSetupRuntime"], { updateBotProfileCount() {} });
  for (const state of ["SETUP", "ON_AIR", "FAULT"]) {
    context.snapshot.state = state;
    context.renderSetupRuntime(context.snapshot);
    assert.equal(elements.appPort.disabled, state !== "SETUP");
  }
});

test("desktop output test tones use live state, stable buttons, and cannot run ON_AIR or FAULT", () => {
  const { context, elements, commands } = ui(["toggleOutputTestTone", "renderTestTones"]);
  context.snapshot.output = { state: "READY", activeChannelCount: 2, testToneOutputs: [] };
  context.renderTestTones(context.snapshot);
  assert.equal(elements.outputTestTones.children.length, 2);
  const button = elements.outputTestTones.children[0]; button.click();
  assert.deepEqual(commands[0], { type: "SET_OUTPUT_TEST_TONE", output: 0, active: true });
  context.snapshot.output.testToneOutputs = [0];
  context.renderTestTones(context.snapshot); assert.equal(elements.outputTestTones.children[0], button);
  button.click(); assert.deepEqual(commands[1], { type: "SET_OUTPUT_TEST_TONE", output: 0, active: false });
  for (const state of ["ON_AIR", "FAULT"]) {
    context.snapshot.state = state; context.renderTestTones(context.snapshot); button.click(); context.toggleOutputTestTone(0);
    assert.equal(button.disabled, true); assert.equal(commands.length, 2);
  }
});

test("TX matrix shows assignment only while the shared MIX action confirms the configured destination", () => {
  const tags: string[] = [], confirmations: string[] = [];
  const { context, elements, commands } = ui(["renderTxAssignments", "operateTxAssignment"], {
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 }, txAssignmentSignature: "",
    document: { createElement: (tag: string) => { tags.push(tag); return new Element(); } },
    confirm: (message: string) => { confirmations.push(message); return true; },
  });
  const stem = { profileId: "TX01", label: "Announcement", guildId: "guild", voiceChannelId: "old", voiceChannelName: "Team 01", state: "READY", active: false, sourceInputChannelId: "local-input:1" };
  context.snapshot.discord.txStems = [stem];
  context.snapshot.discord.availableVoiceChannels = [{ id: "new", guildId: "guild", name: "Team 02" }, { id: "wrong", guildId: "else", name: "Other Guild" }];
  context.snapshot.input = { state: "READY", selectedDeviceId: "pa:1" };
  context.snapshot.channels = [{ id: "local-input:1", label: "IN 1", kind: "LocalMonoInput" }];
  context.renderTxAssignments(context.snapshot);
  assert.equal(tags.includes("select"), false, "VC selectors are absent, not hidden");
  assert.doesNotMatch(script, /function assignTxVoiceChannel\(/);
  const header = elements.txAssignmentList.children[0].children[0].children[0].children[1];
  assert.equal(header.children[0].textContent, "Announcement");
  assert.equal(header.children[1].textContent, "MONO · READY");
  assert.equal(header.children.length, 3, "no redundant start/stop buttons in ROUTE");
  context.operateTxAssignment("TX01", true);
  assert.deepEqual(commands, [{ type: "START_TX", profileId: "TX01", confirmed: true }]);
  assert.match(confirmations[0], /Team 01/);
  assert.doesNotMatch(confirmations[0], /Team 02/);
  stem.active = true; stem.state = "SENDING"; context.renderTxAssignments(context.snapshot);
  context.operateTxAssignment("TX01", true); assert.equal(commands.length, 1);
  context.operateTxAssignment("TX01", false);
  assert.deepEqual(commands[1], { type: "STOP_TX", profileId: "TX01", confirmed: true });
});

test("Bot settings remove SPARE and fixed TX categories while preserving old metadata and MONO/STEREO", () => {
  const { context, elements } = ui(["setSelectOptions", "syncControlSelect", "generatedTokenEnvironment", "nextBotProfileId", "updateBotProfileTxFields", "refreshBotProfileLocationOptions", "createBotProfileCard", "botSettingsFromCard"], { populateTxDestinations() {} });
  context.snapshot.discord.availableVoiceChannels = [{ guildId: "100000000000000001", id: "200000000000000001", name: "Team 01" }];
  const card = context.createBotProfileCard({ id: "TX01", role: "TX", txSubtype: "GAME", txDestination: "TEAM_01", txAudioMode: "STEREO", guildId: "100000000000000001", voiceChannelId: "" }, true);
  assert.equal(card.querySelector('[data-setting="id"]').readOnly, true);
  assert.equal(card.querySelector('[data-setting="voiceChoice"]').value, "", "available VC never auto-assigns");
  const bot = context.botSettingsFromCard(card);
  assert.equal(bot.txSubtype, "GAME"); assert.equal(bot.txAudioMode, "STEREO");
  assert.equal(bot.txDestination, "TEAM_01", "old metadata survives an unrelated settings save");
  card.querySelector('[data-setting="role"]').value = "RX"; context.updateBotProfileTxFields(card);
  assert.equal(card.querySelector('[data-setting="txAudioMode"]').disabled, true);
  assert.doesNotMatch(html, /id="add-spare-profile"/);
  assert.doesNotMatch(script, /value="SPARE"|data-setting="txSubtype"|data-setting="txDestination"/);
  const spare = context.createBotProfileCard({ id: "old-spare", role: "SPARE" });
  assert.equal(context.botSettingsFromCard(spare).role, "SPARE", "unrelated saves preserve legacy receiver ownership");
  assert.equal(spare.querySelector(".bot-role-badge").textContent, "RX");
  spare.querySelector('[data-setting="role"]').value = "TX";
  assert.equal(context.botSettingsFromCard(spare).role, "TX", "explicit role changes still work");
});

test("shared Guild edits preserve per-Bot overrides, clear changed VCs and cannot edit live settings", () => {
  let dirty = 0;
  const { context, elements } = ui(["changeSharedGuild"], { markSettingsDirty() { dirty++; }, refreshBotProfileLocationOptions() {} });
  const old = "100000000000000001", next = "100000000000000002", override = "100000000000000003";
  const cards = [old, "", override].map(guild => {
    const card = new Element(); card.querySelector('[data-setting="guildId"]').value = guild;
    card.querySelector('[data-setting="voiceChannelId"]').value = "200000000000000001"; return card;
  });
  elements.botProfileList.children = cards; elements.sharedGuildId.dataset.previous = old; elements.sharedGuildId.value = next;
  context.changeSharedGuild();
  assert.deepEqual(cards.map(card => card.querySelector('[data-setting="guildId"]').value), [next, next, override]);
  assert.deepEqual(cards.map(card => card.querySelector('[data-setting="voiceChannelId"]').value), ["", "", "200000000000000001"]);
  for (const state of ["ON_AIR", "FAULT"]) { context.snapshot.state = state; context.changeSharedGuild(); }
  context.snapshot.state = "SETUP"; context.localSettingsAvailable = false; context.changeSharedGuild();
  assert.equal(dirty, 1);
});

test("portable Bot profiles whitelist fields, never import Token, and require explicit save", async () => {
  let dirty = 0;
  const imported: any[] = [];
  const { context, elements, commands, notices } = ui(["portableBotProfiles", "importBotProfiles", "generatedTokenEnvironment"], {
    createBotProfileCard(bot: unknown) { imported.push(bot); return new Element(); }, markSettingsDirty() { dirty++; }, updateBotProfileCount() {},
  });
  const bot = { id: "RX01", label: "Red", role: "RX", guildId: "100000000000000001", voiceChannelId: "", enabled: true, token: "secret-token", tokenEnv: "SECRET_ENV" };
  const exported = context.portableBotProfiles([bot]);
  assert.doesNotMatch(JSON.stringify(exported), /secret-token|SECRET_ENV|token/i);
  context.settingsSnapshot.bots = [{ id: "RX01", tokenEnv: "EXISTING_TOKEN", tokenConfigured: true }];
  const file = { size: 500, text: async () => JSON.stringify({ ...exported, bots: [bot] }) };
  (elements.importBotProfiles as any).files = [file]; elements.importBotProfiles.value = "selected.json";
  await context.importBotProfiles();
  assert.equal(elements.importBotProfiles.value, ""); assert.equal(dirty, 1); assert.equal(imported[0].tokenEnv, "EXISTING_TOKEN");
  assert.equal(imported[0].token, undefined); assert.equal(commands.length, 0);
  assert.doesNotMatch(notices.join(" "), /secret-token|SECRET_ENV/);
  file.text = async () => { context.snapshot.state = "ON_AIR"; return JSON.stringify(exported); };
  await context.importBotProfiles(); assert.equal(dirty, 1, "async import rechecks state");
});

test("LAN enable requires confirmation before settings save and remains opt-in", async () => {
  let requests = 0;
  const { context, elements } = ui(["saveBotProfiles"], { confirm: () => false, fetch: async () => { requests++; return { ok: true, json: async () => ({ settings: {} }) }; }, renderDesktopSettings() {}, loadTabletAdmin() {}, botSettingsFromCard() {} });
  elements.lanAccessEnabled.checked = true; elements.appPort.value = "4173"; elements.tabletPort.value = "4174";
  await context.saveBotProfiles({ preventDefault() {} }); assert.equal(requests, 0);
  context.confirm = () => true;
  await context.saveBotProfiles({ preventDefault() {} }); assert.equal(requests, 1);
});

test("device choices are grouped by driver, while shared ASIO Cue uses spare Main channels only", () => {
  const { context, elements, commands } = ui(["setSelectOptions", "syncControlSelect", "physicalOutputClaims", "selectedOutputConflict", "renderSharedCue", "applySharedCue"]);
  context.setSelectOptions(elements.outputDevice, [{ value: "pa:1", label: "Rubix", group: "Windows WASAPI" }, { value: "pa:2", label: "Rubix ASIO", group: "ASIO" }]);
  assert.deepEqual(elements.outputDevice.children.map((group: any) => group.label), ["Windows WASAPI", "ASIO"]);
  assert.equal(elements.outputDevice.children[1].children[0].value, "pa:2");
  context.snapshot.output = { state: "READY", selectedDeviceId: "pa:2", selectedDeviceName: "Rubix", selectedHostApi: "ASIO", activeChannelCount: 4 };
  context.snapshot.buses = [{ id: "bus", physicalOutputs: [{ output: 0 }, { output: 1 }] }];
  elements.sharedCueMode.value = "DUAL_MONO";
  context.renderSharedCue(context.snapshot);
  elements.sharedCueChannel.value = "2"; context.renderSharedCue(context.snapshot);
  const option = elements.sharedCueChannel.children[3]; context.renderSharedCue(context.snapshot);
  assert.equal(elements.sharedCueChannel.children[3], option, "state refresh preserves select DOM");
  context.applySharedCue(); assert.deepEqual(commands, [{ type: "SET_MONITOR_OUTPUT", output: 2, mode: "DUAL_MONO" }]);
  elements.sharedCueChannel.value = "0"; context.applySharedCue(); assert.equal(commands.length, 1, "Main collision rejected");
  elements.sharedCueChannel.value = "2"; context.snapshot.discord.txStems = [{ active: true }]; context.applySharedCue(); assert.equal(commands.length, 1);
  context.snapshot.discord.txStems = []; context.snapshot.cueOutput = { state: "READY", selectedDeviceId: "pa:3" }; context.applySharedCue(); assert.equal(commands.length, 1);
  context.renderSharedCue(context.snapshot); assert.equal(elements.applySharedCue.disabled, true);
});

test("matrix Direct Out preserves PRE/POST and rejects collisions, closed hardware and structural locks", () => {
  const { context, commands } = ui(["physicalOutputClaims", "selectedOutputConflict", "applyMatrixDirect"]);
  context.snapshot.channels = [{ id: "person", label: "Guest", directOutput: null }];
  context.snapshot.output = { state: "READY", selectedDeviceId: "pa:2", activeChannelCount: 4, devices: [{ id: "pa:2", backend: "portaudio" }] };
  context.snapshot.buses = [{ id: "bus", physicalOutputs: [{ output: 0 }] }];
  context.applyMatrixDirect("person", 0); assert.equal(commands.length, 0);
  context.applyMatrixDirect("person", 1); assert.deepEqual(commands.pop(), { type: "SET_DIRECT_OUTPUT", channelId: "person", output: 1, tap: "PRE", confirmed: true });
  context.snapshot.channels[0].directOutput = { output: 1, tap: "POST" };
  context.applyMatrixDirect("person", 2); assert.equal(commands.pop().tap, "POST");
  context.applyMatrixDirect("person", null); assert.deepEqual(commands.pop(), { type: "CLEAR_DIRECT_OUTPUT", channelId: "person" });
  for (const state of ["ON_AIR", "FAULT"]) { context.snapshot.state = state; context.applyMatrixDirect("person", null); }
  context.snapshot.state = "SETUP"; context.snapshot.output.state = "STOPPED"; context.applyMatrixDirect("person", 2);
  assert.equal(commands.length, 0);
});

test("group UI submits post-VC membership without mutating existing output routes", () => {
  const { context, elements, commands } = ui(["applyGroupBus"]);
  elements.groupBusName.value = "赤";
  const box = new Element(); box.value = "vc-one"; box.checked = true; elements.groupBusMembers.children = [box];
  context.applyGroupBus(); assert.deepEqual(commands.pop(), { type: "CREATE_VC_BUS", name: "赤", groupSourceIds: ["vc-one"] });
  elements.groupBusSelect.value = "red"; context.applyGroupBus(); assert.deepEqual(commands.pop(), { type: "SET_GROUP_BUS_SOURCES", busId: "red", sourceBusIds: ["vc-one"] });
  context.snapshot.state = "ON_AIR"; context.applyGroupBus(); assert.equal(commands.length, 0);
});

test("master header selects its VC participants without altering audio or requiring the top filter", () => {
  let selected: unknown;
  const { context, elements, commands } = ui(["createMasterStrip"], {
    masterRefs: new Map(), bindFader() {}, mixBots: (state: any) => state.discord.bots,
    selectedMixBotProfileId: "all", mixBankIndex: 3,
    renderMixBotFilter() {}, renderParticipants(_state: unknown, bot: unknown) { selected = bot; }, renderMasters() {},
  });
  const node = new Element();
  (elements.masterTemplate as any).content = { firstElementChild: { cloneNode: () => node } };
  const bus = { id: "vc", label: "Voice", linkedDiscordGuildId: "guild", linkedDiscordVoiceChannelId: "voice", mute: false };
  const bot = { profileId: "RX01", label: "Operator label", guildId: "guild", voiceChannelId: "voice" };
  context.snapshot.buses = [bus]; context.snapshot.discord.bots = [bot];
  context.createMasterStrip(bus); node.querySelector("header").click();
  assert.equal(context.selectedMixBotProfileId, "RX01"); assert.equal(context.mixBankIndex, 0);
  assert.equal(selected, bot); assert.equal(commands.length, 0);
  node.querySelector(".vc-master-mute").click();
  assert.deepEqual(commands[0], { type: "SET_BUS_MUTE", busId: "vc", mute: true });
});

test("desktop Recall Safe updates Preview protection without recalling and rejects locked or unknown parameters", () => {
  const { context, commands } = ui(["setRecallSafe"], { scenePreview: { changes: [{ parameter: "bus:one:masterDb", recallSafe: false }] }, scenePreviewSignature: "old", renderScenes() {} });
  context.snapshot.sceneParameters = [{ parameter: "bus:one:masterDb" }];
  context.setRecallSafe("missing", true); assert.equal(commands.length, 0);
  context.setRecallSafe("bus:one:masterDb", true);
  assert.deepEqual(commands[0], { type: "SET_RECALL_SAFE", parameter: "bus:one:masterDb", safe: true });
  assert.equal(context.scenePreview.changes[0].recallSafe, true); assert.equal(context.scenePreviewSignature, "");
  for (const state of ["ON_AIR", "FAULT"]) { context.snapshot.state = state; context.setRecallSafe("bus:one:masterDb", false); }
  assert.equal(commands.length, 1);
});

test("desktop event log clearing requires confirmation and never deletes operational log files", () => {
  const { context, commands } = ui(["clearEventLog"]);
  context.confirm = () => false; context.clearEventLog(); assert.equal(commands.length, 0);
  context.confirm = () => true; context.clearEventLog(); assert.deepEqual(commands[0], { type: "CLEAR_EVENT_LOG", confirmed: true });
  for (const state of ["ON_AIR", "FAULT"]) { context.snapshot.state = state; context.clearEventLog(); }
  assert.equal(commands.length, 1);
  assert.match(html, /id="status-log-filter"/); assert.match(html, /id="status-log-level"/);
});

test("desktop Audio I/O retains non-Windows device access while requiring Windows endpoint bindings", () => {
  const { context } = ui(["requiresWindowsEndpoint"]);
  for (const hostApi of ["Windows WASAPI", "Windows DirectSound", "Windows WDM-KS", "MME"]) assert.equal(context.requiresWindowsEndpoint({ id: "pa:1", hostApi }), true);
  for (const hostApi of ["ASIO", "Core Audio", "ALSA"]) assert.equal(context.requiresWindowsEndpoint({ id: "pa:1", hostApi }), false);
});

test("legacy POST recovery is explicit, local, locked while live and leaves VC MIX commands alone", () => {
  const channel = { id: "guest", label: "Guest", kind: "DiscordUser", faderDb: -18, mute: true };
  const { context, elements, commands } = ui(["legacyPostChannels", "restoreLegacyPost", "renderLegacyPostRecovery"], {
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 },
  });
  context.snapshot.channels = [channel, { ...channel, id: "normal", faderDb: 0, mute: false }];
  context.renderLegacyPostRecovery(context.snapshot);
  assert.equal(elements.legacyPostRecovery.hidden, false);
  assert.equal(elements.legacyPostList.children.length, 1);
  assert.equal(commands.length, 0, "restoring an old profile must not modify it automatically");
  const restore = () => elements.legacyPostList.children[0].children[1];
  context.confirm = () => false; restore().click(); assert.equal(commands.length, 0);
  context.confirm = () => true; restore().click();
  assert.deepEqual(commands, [{ type: "SET_CHANNEL_FADER", channelId: "guest", db: 0 }, { type: "SET_CHANNEL_MUTE", channelId: "guest", mute: false }]);
  for (const state of ["ON_AIR", "FAULT"]) {
    context.snapshot.state = state; context.renderLegacyPostRecovery(context.snapshot);
    assert.equal(restore().disabled, true); context.restoreLegacyPost("guest"); assert.equal(commands.length, 2);
  }
  context.snapshot.state = "READY"; context.localSettingsAvailable = false;
  context.renderLegacyPostRecovery(context.snapshot); context.restoreLegacyPost("guest");
  assert.equal(elements.legacyPostRecovery.hidden, true); assert.equal(commands.length, 2);
  context.localSettingsAvailable = true; channel.faderDb = 0; channel.mute = false;
  context.renderLegacyPostRecovery(context.snapshot); assert.equal(elements.legacyPostRecovery.hidden, true);
});

test("desktop audio-taper fader preserves the full dB range and inverse mapping near unity", () => {
  const { context } = ui(["interpolateCurve", "dbToFaderPosition", "faderPositionToDb", "clampDb"]);
  assert.equal(context.dbToFaderPosition(-90), 0); assert.equal(context.dbToFaderPosition(0), 780); assert.equal(context.dbToFaderPosition(12), 1000);
  assert.equal(context.clampDb(-100), -90);
  for (const db of [-90, -60, -40, -30, -20, -10, -5, 0, 5, 10, 12]) assert.equal(context.faderPositionToDb(context.dbToFaderPosition(db)), db);
  assert.match(script, /meter\.peak >= 0\.999|peak >= 0\.999/);
  assert.match(html, /class="input-meter-fill"/); assert.doesNotMatch(html, /class="output-meter-fill"/); assert.match(html, /id="mix-search"/);
});
