import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../services/router-core-sim/public/styles.css", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../services/router-core-sim/src/server.ts", import.meta.url), "utf8");

test("participant controls only operate VC MIX send and expose no unused POST controls", () => {
  const fields: Record<string, any> = {};
  const commands: any[] = [];
  const faders: any[] = [];
  const node = {
    dataset: {} as Record<string, string>,
    addEventListener() {},
    querySelector(selector: string) {
      return fields[selector] ??= { listeners: {} as Record<string, () => void>, addEventListener(event: string, handler: () => void) { this.listeners[event] = handler; } };
    },
  };
  const channel = { id: "guest", mute: false, vcSends: { vc: { mute: false, gainDb: -12 } } };
  const context: any = {
    elements: { template: { content: { firstElementChild: { cloneNode: () => node } } }, participants: { append() {} } },
    snapshot: { channels: [channel] }, stripRefs: new Map(),
    bindFader: (_range: unknown, _number: unknown, key: () => string, command: (db: number) => unknown) => faders.push({ key, command }),
    sendCommand: (command: unknown) => commands.push(JSON.parse(JSON.stringify(command))),
  };
  const start = script.indexOf("function createStrip(");
  runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  context.createStrip(channel);
  node.dataset.busId = "vc";
  fields[".bus-send-toggle"].listeners.click();
  assert.deepEqual(commands.pop(), { type: "SET_VC_SEND", channelId: "guest", busId: "vc", mute: true });
  const mix = faders.find((fader) => fader.key().startsWith("send:"));
  assert.deepEqual(JSON.parse(JSON.stringify(mix.command(-6))), { type: "SET_VC_SEND", channelId: "guest", busId: "vc", db: -6 });
  assert.equal(faders.length, 1, "only the VC MIX send fader is bound");
  const strip = html.slice(html.indexOf('<template id="participant-template"'));
  assert.match(strip, /class="bus-send-fader"/);
  assert.doesNotMatch(strip, /post-controls|channel-fader|strip-on-toggle|output-meter-fill/);
});

test("ROUTE matrix displays 16 VC rows and guards routing, bank switching and exclusive Cue", () => {
  // Run the shipped browser functions with a tiny DOM, without opening hardware or Discord.
  class Element {
    children: Element[] = [];
    attributes: Record<string, string> = {};
    listeners: Record<string, () => void> = {};
    value = "MONO";
    textContent = "";
    className = "";
    title = "";
    disabled = false;
    type = "";
    scope = "";
    open = false;
    tag: string;
    constructor(tag = "div") { this.tag = tag; }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    insertRow() { const row = new Element("tr"); this.append(row); return row; }
    insertCell() { const cell = new Element("td"); this.append(cell); return cell; }
    createTHead() { const head = new Element("thead"); this.append(head); return head; }
    createTBody() { const body = new Element("tbody"); this.append(body); return body; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    getAttribute(key: string) { return this.attributes[key]; }
    addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
    click() { if (!this.disabled) this.listeners.click?.(); }
  }
  const ids = ["routeOverviewCount", "routeMatrixDevice", "routeMatrixMode", "routeMatrixPrev", "routeMatrixNext", "routeMatrixBank", "routeSelectedDetails", "routeSelectedSummary", "vcRouteList"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const groups = Array.from({ length: 16 }, (_, index) => ({ guildId: "guild", voiceChannelId: `vc-${index}`, voiceChannelName: "vc", status: "ACTIVE", receivers: [], ownerProfileId: `rx-${index}` }));
  const buses = groups.map((group, index) => ({ id: `bus-${index}`, label: `TEAM ${index + 1}`, linkedDiscordGuildId: group.guildId, linkedDiscordVoiceChannelId: group.voiceChannelId, participantCount: 1, physicalOutputs: [{ output: index }] }));
  const fixture = {
    state: "SETUP", channels: [], buses,
    discord: { receiverOwnership: groups, txStems: [], bots: groups.map((group, index) => ({ ...group, profileId: `rx-${index}`, label: `RX TEAM ${index + 1}`, health: "READY" })) },
    output: { state: "READY", selectedDeviceId: "main", selectedDeviceName: "Main ASIO", activeChannelCount: 64, devices: [{ id: "main", backend: "portaudio", maxOutputChannels: 64 }] },
    cueOutput: { state: "READY", selectedDeviceId: "cue", selectedDeviceName: "Headphones", devices: [{ id: "cue", backend: "portaudio" }] },
    monitorSourceId: null,
  };
  const commands: unknown[] = [];
  let confirmed = false;
  const context: any = {
    snapshot: fixture, settingsSnapshot: null, elements, document: { createElement: (tag: string) => new Element(tag) },
    routeMatrixBank: 0, routeOverviewSignature: "", selectedRouteVcKey: "guild:vc-0", ioOptionsSignature: "", directRouteSignature: "",
    routeBots: (state: typeof fixture) => state.discord.bots, internalTxPaths: () => [],
    participantDisplayName: (_state: unknown, channel: { id: string }) => channel.id,
    renderIo: () => {}, renderGroupBuses: () => {}, expandedRouteVcs: new Set(), showNotice: () => {}, confirm: () => confirmed,
    sendCommand: (command: unknown) => commands.push(JSON.parse(JSON.stringify(command))),
  };
  const names = ["configuredReceiverGroups", "configuredTxStems", "routeVcKey", "audioDeviceNameplate", "configuredVoiceRoutes", "teamRxBuses", "commonTeamOutput", "physicalOutputClaims", "selectedOutputConflict", "physicalMonitorReady", "renderRouteOverview", "applyRouteOutput", "applyMatrixDirect"];
  runInNewContext(names.map((name) => {
    const start = script.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return script.slice(start, script.indexOf("\n}", start) + 2);
  }).join("\n"), context);
  const render = () => context.renderRouteOverview(fixture);
  const rows = () => elements.vcRouteList.children[0].children.find((node) => node.tag === "tbody")!.children;
  const tableHeader = () => elements.vcRouteList.children[0].children.find((node) => node.tag === "thead")!.children[0].children;
  render();
  assert.equal(rows().length, 17, "16 VC plus the TeamBus aggregate row");
  assert.equal(rows()[1].children.length, 19, "source, clear, 16 outputs, separate Cue");
  assert.equal(tableHeader()[2].textContent, "OUT 1", "output numbers explicitly name the horizontal axis");
  assert.equal(rows()[1].children[2].children[0].textContent, "✓");
  assert.equal(rows()[1].children[3].children[0].disabled, true, "another VC occupies OUT 2");
  const table = elements.vcRouteList.children[0];
  render();
  assert.equal(elements.vcRouteList.children[0], table, "unchanged meter snapshots preserve DOM/focus");
  context.routeMatrixBank = 1;
  render();
  assert.match(elements.routeMatrixBank.textContent, /OUT 17–32/);
  rows()[1].children[2].children[0].click();
  assert.equal(commands.length, 0, "cancelled confirmation sends no route command");
  confirmed = true;
  rows()[1].children[2].children[0].click();
  assert.deepEqual(commands.pop(), { type: "SET_BUS_OUTPUT", busId: "bus-0", output: 16, mode: "MONO", confirmed: true });
  context.applyRouteOutput(["bus-0"], 1, "MONO");
  assert.equal(commands.length, 0, "collision is checked again at click time");
  rows()[1].children.at(-1)!.children[0].click();
  assert.deepEqual(commands.pop(), { type: "SET_PFL", sourceId: "bus-0" });
  (fixture as any).monitorSourceId = "bus-0";
  render();
  rows()[2].children.at(-1)!.children[0].click();
  assert.deepEqual(commands.pop(), { type: "SET_PFL", sourceId: "bus-1" }, "Cue switches to one source, never a parallel Main route");
  fixture.state = "ON_AIR";
  render();
  assert.equal(rows()[1].children[2].children[0].disabled, true);
  context.applyRouteOutput(["bus-0"], null, "MONO");
  assert.equal(commands.length, 0, "even a stale event cannot clear an ON AIR route");
  fixture.state = "SETUP";
  fixture.output.state = "STOPPED";
  context.applyRouteOutput(["bus-0"], 16, "MONO");
  assert.equal(commands.length, 0, "closed hardware cannot receive a new assignment");
  fixture.output.state = "READY";
  elements.routeMatrixMode.value = "DUAL_MONO";
  context.routeMatrixBank = 3;
  render();
  assert.equal(rows()[1].children.length, 11, "64ch last bank offers eight adjacent pairs");
  context.applyRouteOutput(buses.map((bus) => bus.id), 62, "DUAL_MONO", true);
  assert.equal(commands.length, 16);
  assert.deepEqual(commands[0], { type: "SET_BUS_OUTPUT", busId: "bus-0", output: 62, mode: "DUAL_MONO", allowCollision: true, confirmed: true });
  commands.length = 0;
  context.applyRouteOutput(["bus-0"], 63, "DUAL_MONO");
  assert.equal(commands.length, 0, "pair cannot extend beyond the device");
  for (const bus of buses) bus.physicalOutputs = [{ output: 62 }, { output: 63 }];
  render();
  assert.equal(rows()[0].children[9].children[0].textContent, "✓", "TeamBus shared pair is visible");
  assert.equal(rows()[1].children[9].children[0].disabled, true, "shared TeamBus routes change from the aggregate row only");
  rows()[0].children[9].children[0].click();
  assert.equal(commands.length, 16);
  assert.deepEqual(commands[0], { type: "CLEAR_BUS_OUTPUT", busId: "bus-0" }, "clicking an assigned pair clears the whole route");
  commands.length = 0;
  for (const bus of buses) bus.physicalOutputs = [];
  (fixture as any).channels = [{ id: "direct", directOutput: { output: 32 } }];
  context.applyRouteOutput(["bus-0"], 32, "MONO");
  assert.equal(commands.length, 0, "Direct Out is also a conflicting Main occupant");
  (fixture as any).channels = [];
  (fixture as any).monitorOutput = { leftOutput: 32, mode: "MONO" };
  context.applyRouteOutput(["bus-0"], 32, "MONO");
  assert.equal(commands.length, 0, "Main Monitor output is protected too");
  (fixture as any).monitorOutput = null;
  buses[0].physicalOutputs = [{ output: 0 }, { output: 2 }, { output: 4 }];
  context.applyRouteOutput(["bus-0"], 32, "MONO");
  assert.equal(commands.length, 0, "Advanced routes are not silently flattened");
  fixture.discord.bots[0].health = "DISCONNECTED";
  context.routeBots = (state: typeof fixture) => state.discord.bots.filter((bot) => bot.health === "READY");
  render();
  assert.match(rows()[1].children[0].children[0].textContent, /RX TEAM 1/, "disconnected VCs retain their identifiable Bot name");
  elements.routeMatrixMode.value = "MONO"; context.routeMatrixBank = 0;
  (fixture as any).channels = [{ id: "guest", label: "Guest", kind: "DiscordUser", currentVoiceChannelId: "vc-0" }];
  render(); rows()[1].children[0].children[0].click();
  assert.equal(rows().length, 18, "VC click expands its participant Direct Out row");
  assert.match(rows()[2].children[0].textContent, /guest.*Direct PRE/);
  rows()[2].children[11].children[0].click();
  assert.deepEqual(commands.pop(), { type: "SET_DIRECT_OUTPUT", channelId: "guest", output: 9, tap: "PRE", confirmed: true });
  rows()[2].children.at(-1)!.children[0].click();
  assert.deepEqual(commands.pop(), { type: "SET_PFL", sourceId: "guest" });
  fixture.state = "ON_AIR"; render(); assert.equal(rows()[2].children[11].children[0].disabled, true);
});

test("physical I/O guidance distinguishes device readiness from valid Main routing", () => {
  const start = script.indexOf("function mainOutputGuidance(");
  const context: any = {};
  runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  const state: any = {
    output: { state: "READY", selectedDeviceId: "mock", activeChannelCount: 2, devices: [{ id: "mock", backend: "mock" }, { id: "asio", backend: "portaudio" }] },
    buses: [{ physicalOutputs: [{ output: 63 }] }], channels: [],
    monitorOutput: { leftOutput: 0, mode: "MONO" },
  };
  assert.match(context.mainOutputGuidance(state), /機器を選択.*デバイスを開始/, "Mock READY is not a physical output");
  state.output.selectedDeviceId = "asio";
  assert.match(context.mainOutputGuidance(state), /出力先chが未設定/, "out-of-range bus and Cue monitor do not count as Main routing");
  state.buses.push({ physicalOutputs: [{ output: 0 }, { output: 1 }] });
  state.channels.push({ directOutput: { output: 1 } }, { directOutput: { output: 4 } });
  const before = JSON.stringify(state);
  assert.match(context.mainOutputGuidance(state), /VC MIX 1件 \/ Direct Out 1件/);
  assert.match(html, /設定済みでも.*ALLOW・ミュート・レベル/, "configured routes are not proof of audible sound; explanation remains in help");
  assert.equal(JSON.stringify(state), before, "guidance is read-only");
  state.output.state = "FAULT";
  assert.match(context.mainOutputGuidance(state), /STATUS.*手動復旧/);
  for (const id of ["io-output-guidance", "setup-open-route", "route-open-devices"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /開始前に音量を下げてください.*保存済みの経路/);
  assert.match(html, /受信だけなら不要/);
  assert.match(styles, /\.io-main \{ grid-column: 1 \/ -1;/);
});

test("desktop operator surface separates MIX, ROUTE, STATUS, SESSION and Bot / I/O SETUP", () => {
  assert.match(styles, /@media \(max-width: 1250px\)[^{]*\{[\s\S]*?grid-template-areas: "brand status" "nav nav"/);
  assert.match(styles, /\.status\s*\{[^}]*white-space: nowrap/s);
  for (const id of [
    "application-state",
    "bot-state",
    "voice-channel",
    "participant-count",
    "mix-bot-filter",
    "participants",
    "participant-template",
    "vc-masters",
    "vc-master-list",
    "vc-master-template",
    "emergency-state",
    "output-guard",
    "receiver-guard",
    "show-mix",
    "show-route",
    "show-status",
    "show-session",
    "show-setup",
    "route-view",
    "status-view",
    "session-view",
    "bot-setup-form",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing Phase 1 element #${id}`);
  }
  assert.match(html, /Discord入力/);
  assert.match(html, /class="participant-scope"/);
  assert.match(html, /INは受信音声/);
  assert.match(html, /ALLOW/);
  assert.match(html, /class="bus-send-number" type="number" min="-90" max="12" step="0\.1"/);
  assert.match(html, /class="vc-master-number" type="number" min="-90" max="12" step="0\.1"/);
  assert.match(html, /class="vc-master-fader" type="range" min="0" max="1000" step="1"/);
  assert.match(html, /class="vc-master-mute channel-toggle"/);
  assert.match(script, /function renderMasters\(currentSnapshot\)[\s\S]*const buses = currentSnapshot\.buses/);
  assert.match(script, /renderParticipants\(currentSnapshot, bot, showAll\);\s*renderMasters\(currentSnapshot\);/);
  assert.match(script, /type: "SET_BUS_MASTER", busId: node\.dataset\.busId, db/);
  assert.match(script, /type: "SET_BUS_MUTE", busId: liveBus\.id, mute: !liveBus\.mute/);
  assert.match(script, /updateMeter\(refs\.meter, null, bus\.inputMeter \?\? bus\.meter\)/);
  assert.match(script, /refs\.label\.textContent = bot\?\.label \?\? bus\.label/);
  assert.match(script, /refs\.scope\.textContent = bot \? bus\.label : "VC BUS"/);
  assert.doesNotMatch(html, />\s*(DIRECT|TABLET|TRAY)\s*</i);
  assert.doesNotMatch(html, />\s*SETUP WIZARD\s*</);
  assert.ok(html.indexOf('id="control-state"') < html.indexOf('id="application-control"'), "read-only health precedes safety controls");
  assert.ok(html.indexOf('id="application-control"') < html.indexOf('id="emergency-state"'), "Emergency remains the final header action");
  assert.ok(html.indexOf('id="io-title"') < html.indexOf('id="bot-setup-form"'), "session Audio I/O precedes infrequent Bot settings");
  assert.ok(html.indexOf('id="restart-router"') < html.indexOf('id="bot-setup-form"'), "restart stays with session setup controls");
  assert.match(script, /function showView\(view\) \{\s*window\.scrollTo\(0, 0\)/);
});

test("STATUS separates Main and Cue faults and its guidance only navigates", () => {
  const elements: Record<string, any> = {};
  for (const [, name] of script.matchAll(/\s+(status\w+): document\.querySelector/g)) {
    const article = { className: "" };
    elements[name] = { value: "", replaceChildren() {}, article, closest: () => article, hidden: false, addEventListener: (_event: string, handler: () => void) => { elements[name].click = handler; } };
  }
  elements.clearEventLog = {};
  const state: any = {
    state: "SETUP", emergencyMuted: false, callbackLoad: .1, xruns: 0,
    channels: [], buses: [{ physicalOutputs: [{ output: 0 }] }], alerts: [],
    output: { state: "READY", selectedDeviceId: "main", selectedDeviceName: "Main ASIO", activeChannelCount: 4, devices: [{ id: "main", backend: "portaudio" }] },
    cueOutput: { state: "READY", selectedDeviceId: "mock", devices: [{ id: "mock", backend: "mock" }] },
    input: { state: "READY", selectedDeviceId: "mock" },
    recorder: { state: "IDLE", queuedBlocks: 0, maxQueuedBlocks: 200, droppedBlocks: 0 },
    discord: { configuredBots: 1, readyBots: 1, sources: [] },
    operatorHealth: { overallSeverity: "OK", rootCauses: [], system: [{ id: "output", severity: "OK" }] },
  };
  let view = "";
  let scrolled = false;
  const target: any = { closest: () => null, scrollIntoView: () => { scrolled = true; } };
  const context: any = {
    elements, snapshot: state, statusStatsBaseline: null, statusEventSignature: "",
    document: { querySelector: () => target, createElement: () => ({ textContent: "" }) },
    renderStatusBreakdown() {}, showView: (name: string) => { view = name; },
    sendCommand() { assert.fail("STATUS must not send audio commands"); },
  };
  const functions = ["mainOutputGuidance", "audioDeviceNameplate", "physicalMonitorReady", "statusGuidance", "setStatusCard", "counterDelta", "renderStatus"];
  runInNewContext(functions.map((name) => {
    const start = script.indexOf(`function ${name}(`);
    return script.slice(start, script.indexOf("\n}", start) + 2);
  }).join("\n"), context);
  const navStart = script.indexOf('elements.statusOpenRecovery.addEventListener("click"');
  runInNewContext(script.slice(navStart, script.indexOf("\n});", navStart) + 4), context);
  const render = () => { const before = JSON.stringify(state); context.renderStatus(state); assert.equal(JSON.stringify(state), before); };
  render();
  assert.equal(elements.statusOverall.textContent, "正常");
  state.runtimeInfo = { buildCommit: "0123456789abcdef0123456789abcdef01234567", pcRole: "TX", startedAt: "2026-10-05T00:00:00.000Z" };
  render();
  assert.match(elements.statusRuntimeInfo.textContent, /0123456789abcdef0123456789abcdef01234567.*起動時のPC ROLE TX.*2026-10-05T00:00:00.000Z/);
  assert.match(script, /起動時のPC ROLE/);
  assert.equal(elements.statusOpenRecovery.hidden, true);
  state.cueOutput.state = "FAULT";
  render();
  assert.equal(elements.statusOverall.textContent, "確認");
  assert.match(elements.statusCue.textContent, /Main影響なし/);
  assert.equal(elements.statusIo.article.className, "health-ok");
  assert.match(elements.statusNextAction.textContent, /Cue出力障害/);
  state.operatorHealth.rootCauses = [{ id: "audio", severity: "WARNING", title: "XRUN", summary: "deadline" }];
  render();
  assert.match(elements.statusNextAction.textContent, /Cue出力障害/, "a current Cue fault is not hidden by a historical XRUN warning");
  state.operatorHealth.rootCauses = [];
  elements.statusOpenRecovery.click();
  assert.equal(view, "setup");
  assert.equal(scrolled, true);
  state.output.state = "FAULT";
  state.state = "FAULT";
  render();
  assert.match(elements.statusNextAction.textContent, /本線出力障害/);
  assert.equal(elements.statusIo.article.className, "health-critical");
  assert.match(elements.statusActionDetail.textContent, /音声は自動再開しません/);
  state.emergencyMuted = true;
  render();
  assert.match(elements.statusNextAction.textContent, /緊急停止/);
  state.emergencyMuted = false;
  state.output.state = "READY";
  state.input.state = "FAULT";
  render();
  assert.match(elements.statusNextAction.textContent, /入力デバイス障害/);
  assert.equal(elements.statusInput.article.className, "health-critical");
  assert.equal(elements.statusIo.textContent, "安全停止中", "latched input fault still shows the globally muted Main path");
  state.state = "SETUP";
  state.input.state = "READY";
  state.cueOutput.state = "READY";
  state.buses = [];
  render();
  assert.match(elements.statusNextAction.textContent, /出力先chが未設定/);
  elements.statusOpenRecovery.click();
  assert.equal(view, "route");
  state.output.devices[0].backend = "mock";
  render();
  assert.match(elements.statusNextAction.textContent, /物理出力は停止中/);
  assert.equal(elements.statusOverall.textContent, "確認", "Mock READY must not present physical Main as normal");
  state.operatorHealth.rootCauses = [{ id: "approval", title: "pending", summary: "gate closed" }];
  render();
  elements.statusOpenRecovery.click();
  assert.equal(view, "mix");
  state.operatorHealth.rootCauses = [{ id: "recorder", title: "fault", summary: "recording failed" }];
  render();
  elements.statusOpenRecovery.click();
  assert.equal(view, "session");
  state.operatorHealth.rootCauses = [{ id: "audio", title: "XRUN", summary: "deadline" }];
  target.closest = () => target;
  render();
  elements.statusOpenRecovery.click();
  assert.equal(view, "status");
  assert.equal(target.open, true);
});

test("desktop STATUS is read-only and reuses the sanitized operator health snapshot", () => {
  for (const id of [
    "status-overall",
    "status-next-action",
    "status-action-detail",
    "status-cue",
    "status-input",
    "status-application",
    "status-discord",
    "status-audio",
    "status-io",
    "status-recorder",
    "status-stat-rx",
    "status-stat-sources",
    "status-stat-tx",
    "status-stat-io",
    "status-stat-recorder",
    "status-stats-since",
    "status-refresh",
    "status-reset",
    "status-bot-list",
    "status-user-list",
    "status-event-list",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing desktop STATUS element #${id}`);
  assert.match(script, /function renderStatus\(currentSnapshot\)/);
  assert.match(script, /const health = currentSnapshot\.operatorHealth/);
  assert.match(script, /statusEventSignature/);
  assert.match(script, /const events = currentSnapshot\.alerts \?\? \[\]/);
  assert.match(script, /discord\.packets/);
  assert.match(script, /tx\?\.framesSent/);
  assert.match(script, /output\?\.framesWritten/);
  assert.match(script, /elements\.statusEventList\.replaceChildren/);
  const statusBody = script.slice(script.indexOf("function renderStatus"), script.indexOf("function renderSummary"));
  assert.doesNotMatch(statusBody, /sendCommand\(/);
});

test("desktop STATUS derives Bot and User counters from the current snapshot and resets only its display baseline", () => {
  assert.match(script, /function renderStatusBreakdown\(currentSnapshot\)/);
  assert.match(script, /source\.botId === bot\.botId/);
  assert.match(script, /participantDisplayName\(currentSnapshot, channel\)/);
  assert.match(script, /source\.decodedSamples/);
  assert.match(script, /bot\.wsPingMs/);
  assert.match(script, /statusStatsBaseline = captureStatusBaseline\(snapshot\)/);
  assert.match(script, /Runtime累積値は保持/);
  assert.match(script, /fetch\("\/api\/state", \{ cache: "no-store" \}\)/);
  const controls = script.slice(script.indexOf("elements.statusRefresh.addEventListener"), script.indexOf("elements.showMix.addEventListener"));
  assert.doesNotMatch(controls, /sendCommand\(|localStorage|sessionStorage/);
  assert.match(styles, /\.status-breakdown/);
});

test("desktop MIX uses the nonce-protected root entry point without legacy aliases", () => {
  assert.match(serverSource, /pathname === "\/" \? "index\.html" : pathname\.slice\(1\)/);
  assert.doesNotMatch(serverSource, /\/minimal/);
  assert.match(serverSource, /requested === "index\.html"/);
  assert.match(script, /meta\[name="dbr-session-nonce"\]/);
  assert.match(script, /\/ws\?nonce=/);
  assert.match(script, /fetch\("\/api\/state"/);
});

test("desktop surface uses only approved operator, physical I/O and explicit TX commands", () => {
  const commandTypes = new Set([...script.matchAll(/type:\s*"([A-Z_]+)"/g)].map((match) => match[1]));
  assert.deepEqual(commandTypes, new Set([
    "SET_RECALL_SAFE",
    "CLEAR_EVENT_LOG",
    "CREATE_VC_BUS",
    "REMOVE_VC_BUS",
    "SET_OUTPUT_TEST_TONE",
    "SET_PARTICIPANT_APPROVAL",
    "SET_USER_STRIP_ORDER",
    "SET_BUS_MASTER",
    "SET_BUS_MUTE",
    "SET_PFL",
    "SET_MONITOR_OUTPUT",
    "SET_GROUP_BUS_SOURCES",
    "SET_VC_SEND",
    // Local SETUP recovery only; participant strips still expose VC MIX controls.
    "SET_CHANNEL_FADER",
    "SET_CHANNEL_MUTE",
    "CONNECT_DISCORD_BOT",
    "DISCONNECT_DISCORD_BOT",
    "SET_RECEIVER_OWNER",
    "SAVE_SCENE",
    "PREVIEW_SCENE",
    "RECALL_SCENE",
    "DELETE_SCENE",
    "START_RECORDING",
    "STOP_RECORDING",
    "REFRESH_OUTPUT_DEVICES",
    "REFRESH_CUE_OUTPUT_DEVICES",
    "REFRESH_INPUT_DEVICES",
    "SELECT_OUTPUT_DEVICE",
    "SELECT_CUE_OUTPUT_DEVICE",
    "SELECT_INPUT_DEVICE",
    "SET_BUS_OUTPUT",
    "CLEAR_BUS_OUTPUT",
    "SET_DIRECT_OUTPUT",
    "CLEAR_DIRECT_OUTPUT",
    "SET_TX_INPUT",
    "START_TX",
    "STOP_TX",
    "EMERGENCY_MUTE",
    "SET_STATE",
    "ACKNOWLEDGE_FAULT",
  ]));
  assert.match(html, /id="recall-safe-panel"/, "Scene protection remains reachable in SESSION");
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test("SESSION keeps recording and recall visible, with save and destructive actions folded separately", () => {
  const session = html.match(/<section id="session-view"[\s\S]*?(?=<section id="route-view")/)?.[0] ?? "";
  assert.ok(session.indexOf('aria-labelledby="recorder-title"') < session.indexOf('aria-labelledby="scene-title"'));
  for (const [id, control] of [
    ["scene-save-details", "save-scene"],
    ["scene-maintenance-details", "delete-scene"],
    ["recorder-track-details", "recorder-tracks"],
  ]) {
    assert.match(session, new RegExp(`<details id="${id}" class="session-details">[\\s\\S]*?id="${control}"[\\s\\S]*?</details>`));
    assert.doesNotMatch(session, new RegExp(`<details[^>]*id="${id}"[^>]*\\bopen\\b`));
  }
  assert.ok(session.indexOf('id="stop-recording"') < session.indexOf('id="recorder-track-details"'));
  assert.ok(session.indexOf('id="recall-scene"') < session.indexOf('id="scene-save-details"'));
  assert.match(session, /aria-label="Main Output録音対象"/);
  assert.match(styles, /@media \(max-width: 1100px\)\s*{\s*\.session-grid { grid-template-columns: minmax\(0, 1fr\); }/);
  assert.match(script, /const busy = recorder\.state === "RECORDING" \|\| recorder\.state === "STOPPING"/);
  assert.match(script, /elements\.stopRecording\.disabled = recorder\.state !== "RECORDING"/);
  assert.match(script, /refs\.input\.disabled = busy \|\| !recorder\.selectionSupported/);
});

test("desktop SESSION requires Scene Preview and preserves recall safety locks", () => {
  for (const id of [
    "application-port",
    "scene-current",
    "scene-name",
    "save-scene",
    "scene-select",
    "preview-scene",
    "overwrite-scene",
    "delete-scene",
    "recall-scene",
    "scene-preview-summary",
    "scene-preview-list",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing desktop Scene element #${id}`);
  assert.match(html, /Recall前に必ずPreviewを表示します/);
  assert.match(script, /message\.payload\.data\?\.kind === "scene-preview"/);
  assert.match(script, /scenePreview\.excludedParticipants/);
  assert.match(script, /Scene保存後に参加/);
  assert.match(script, /scenePreview\?\.sceneId === selectedScene\.id/);
  assert.match(script, /if \(!scene \|\| scenePreview\?\.sceneId !== scene\.id\)/);
  assert.match(script, /type: "PREVIEW_SCENE"/);
  assert.match(script, /type: "SAVE_SCENE", sceneId: scene\.id, name: scene\.name, confirmed: true/);
  assert.match(script, /type: "RECALL_SCENE", sceneId: scene\.id, confirmed: true/);
  assert.match(script, /type: "DELETE_SCENE", sceneId: scene\.id, confirmed: true/);
  assert.match(script, /currentSnapshot\.state === "ON_AIR" \|\| currentSnapshot\.state === "FAULT"/);
  assert.match(script, /elements\.recallScene\.disabled = !previewMatches \|\| currentSnapshot\.state === "FAULT"/);
  assert.match(script, /type: "SET_RECALL_SAFE", parameter, safe/, "Recall Safe is migrated without automatic Scene recall");
});

test("desktop SESSION records explicit Output, VC MIX and User selections with confirmation", () => {
  for (const id of [
    "recorder-state",
    "recorder-duration",
    "recorder-track-count",
    "recorder-queue",
    "recorder-disk-free",
    "recorder-outputs",
    "recorder-targets",
    "recorder-selection-summary",
    "recorder-users",
    "recorder-buses",
    "start-recording",
    "stop-recording",
    "recorder-folder",
    "recorder-tracks",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing desktop Recorder element #${id}`);
  assert.match(html, /チェックした音声ごとに、1chの48 kHz Float WAV/);
  assert.match(html, /DROPPED/);
  assert.match(script, /const preferredOutput = recorder\.startedAt \? recorder\.matrixOutput : currentMix\?\.physicalOutputs\?\.\[0\]\?\.output \?\? 0/);
  assert.match(script, /MATRIX: "MAIN", VC_BUS: "VC MIX PRE", DISCORD_USER: "USER PRE", LOCAL_INPUT: "INPUT PRE"/);
  assert.match(html, /VC MIXとUser \/ InputはPRE録音/);
  assert.match(script, /type: "START_RECORDING", matrixOutput, includeUsers, includeBuses, selection, confirmed: true/);
  assert.match(script, /type: "STOP_RECORDING", confirmed: true/);
  assert.match(script, /録音を停止してWAV Headerを確定しますか/);
  assert.match(script, /const recorderTrackRefs = new Map\(\)/);
  assert.match(script, /key: `\$\{index\}:\$\{track\.kind\}`/);
  assert.doesNotMatch(script, /recorderTrackRefs\.get\(track\.fileName\)/);
  assert.match(script, /recorderTargetRefs = new Map/);
  assert.match(html, /途中参加のUserを自動追加しません/);
});

test("recording checkboxes survive meter updates, freeze while busy, and never silently add or remove targets", () => {
  class Element {
    children: Element[] = [];
    parent?: Element;
    listeners: Record<string, () => void> = {};
    textContent = "";
    className = "";
    checked = false;
    disabled = false;
    hidden = false;
    append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
    addEventListener(type: string, listener: () => void) { this.listeners[type] = listener; }
    querySelector() { return this.children.find((node) => node.className === "session-empty"); }
    querySelectorAll() { return []; }
  }
  const elements = Object.fromEntries(["recorderTargets", "recorderOutputs", "recorderBuses", "recorderUsers", "recorderOutputsCount", "recorderBusesCount", "recorderUsersCount", "recorderSelectionSummary", "recorderState", "recorderDuration", "recorderTrackCount", "recorderQueue", "recorderDiskFree", "recorderFolder", "recorderMessage", "startRecording", "stopRecording"].map((id) => [id, new Element()]));
  const snapshot = {
    output: { activeChannelCount: 4 }, buses: [
      { id: "b1", label: "vc", linkedDiscordGuildId: "guild-1", linkedDiscordVoiceChannelId: "vc-1" },
      { id: "b2", label: "vc", linkedDiscordGuildId: "guild-2", linkedDiscordVoiceChannelId: "vc-1" },
      { id: "local", label: "Local MIX", linkedDiscordGuildId: "", linkedDiscordVoiceChannelId: "" },
    ],
    discord: {
      bots: [
        { guildId: "guild-1", voiceChannelId: "vc-1", profileId: "old", label: "Old Bot", role: "RX", health: "STALE" },
        { guildId: "guild-1", voiceChannelId: "vc-1", profileId: "spare", label: "Spare Bot", role: "SPARE", health: "READY" },
        { guildId: "guild-1", voiceChannelId: "vc-1", profileId: "rx-1", label: "RX TEAM 01", role: "RX", health: "DISCONNECTED" },
        { guildId: "guild-2", voiceChannelId: "vc-1", profileId: "rx-2", label: "RX TEAM 02", role: "RX", health: "READY" },
      ],
      receiverOwnership: [{ guildId: "guild-1", voiceChannelId: "vc-1", ownerProfileId: "rx-1" }],
    },
    channels: [{ id: "u1", label: "Test Guest A" }, { id: "u2", label: "テスト参加者B" }],
    recorder: { state: "IDLE", startedAt: null as string | null, matrixOutput: 63, includeUsers: false, includeBuses: false, selectionSupported: true, selection: undefined as { outputs: number[]; busIds: string[]; channelIds: string[] } | undefined, tracks: [] },
  };
  const start = script.indexOf("function selectedRecordingTargets(");
  const end = script.indexOf("\nfunction renderSession(", start);
  const api = runInNewContext(`let recorderSelection = null, lastRecorderState = null, recorderSessionStartedAt = null;
    const recorderTargetRefs = new Map();
    ${script.slice(start, end)}
    ({render: () => renderRecorder(snapshot), targets: recorderTargetRefs, selected: () => JSON.stringify(selectedRecordingTargets())});`, {
    elements, snapshot, document: { createElement: () => new Element() },
    participantDisplayName: (_state: unknown, channel: { label: string }) => channel.label,
    participantBot: () => null, participantSession: () => null,
    selectedMixMaster: () => null, pickPrimaryBot: () => null,
    formatBytes: () => "—", formatDuration: () => "00:00:00", renderRecorderTracks: () => {},
  });
  api.render();
  assert.equal(api.targets.get("busIds:b1").name.textContent, "RX TEAM 01 · vc", "owner label survives disconnection and ignores stale/spare bots");
  assert.equal(api.targets.get("busIds:b2").name.textContent, "RX TEAM 02 · vc", "identical VC names in different guilds remain distinguishable");
  assert.equal(api.targets.get("busIds:local").name.textContent, "Local MIX", "unlinked buses retain their label");
  const bus = api.targets.get("busIds:b1").input as Element;
  bus.checked = true;
  bus.listeners.change();
  snapshot.buses[0].label = "Team Lobby";
  api.render();
  assert.equal(api.targets.get("busIds:b1").name.textContent, "RX TEAM 01 · Team Lobby");
  assert.equal(api.targets.get("busIds:b1").input, bus, "VC rename preserves the checkbox DOM");
  assert.equal(bus.checked, true);
  bus.checked = false;
  bus.listeners.change();
  assert.equal(elements.recorderOutputs.children.length, 4, "unused default Matrix OUT 64 must not expand a 4ch device");
  const firstOutput = api.targets.get("outputs:0").input as Element;
  const user = api.targets.get("channelIds:u1").input as Element;
  firstOutput.checked = false;
  firstOutput.listeners.change();
  user.checked = true;
  user.listeners.change();
  api.render();
  assert.deepEqual(JSON.parse(api.selected()), { outputs: [], busIds: [], channelIds: ["u1"] });
  assert.equal(api.targets.get("channelIds:u1").input, user, "meter updates preserve the input DOM");
  snapshot.channels.push({ id: "u3", label: "New user" });
  api.render();
  assert.equal(api.targets.get("channelIds:u3").input.checked, false);
  snapshot.recorder.state = "RECORDING";
  snapshot.recorder.startedAt = "2026-10-01T12:00:00Z";
  snapshot.recorder.selection = { outputs: [], busIds: [], channelIds: ["u1"] };
  api.render();
  assert.equal(user.disabled, true);
  assert.equal(elements.startRecording.disabled, true);
  assert.equal(elements.stopRecording.disabled, false);
  user.checked = false;
  user.listeners.change();
  api.render();
  assert.equal(user.checked, true, "even a dispatched change cannot alter a busy session");
  snapshot.recorder.state = "STOPPING";
  api.render();
  assert.equal(user.disabled, true);
  assert.equal(elements.stopRecording.disabled, true);
  snapshot.recorder.state = "IDLE";
  snapshot.channels = snapshot.channels.filter((channel) => channel.id !== "u1");
  api.render();
  assert.equal(user.checked, true, "a vanished selection remains visible rather than silently disappearing");
  assert.equal(elements.startRecording.disabled, true);
  assert.match(elements.recorderSelectionSummary.textContent, /選び直してください/);
  user.checked = false;
  user.listeners.change();
  assert.equal(elements.startRecording.disabled, true, "empty recording cannot start");
  const remaining = api.targets.get("channelIds:u2").input as Element;
  remaining.checked = true;
  remaining.listeners.change();
  assert.equal(elements.startRecording.disabled, false);
  snapshot.recorder.selectionSupported = false;
  api.render();
  assert.equal(elements.startRecording.disabled, true, "an old backend cannot ignore the explicit selection");
  assert.match(elements.recorderSelectionSummary.textContent, /本体を再起動/);
});

test("desktop Receiver Owner view preserves manual fail-closed recovery rules", () => {
  for (const id of [
    "receiver-owner-state",
    "receiver-owner-summary",
    "receiver-owner-list",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing Receiver Owner element #${id}`);
  assert.match(html, /<details class="receiver-owner-panel"/);
  assert.match(html, /自動切替しません。停止時はそのVCだけ無音です/);
  assert.match(script, /const groups = currentSnapshot\.discord\?\.receiverOwnership \?\? \[\]/);
  assert.match(script, /groups\.filter\(\(group\) => group\.status === "ACTIVE"\)/);
  assert.match(script, /currentSnapshot\.state === "ON_AIR" && group\.status === "ACTIVE"/);
  assert.match(script, /currentSnapshot\.state !== "FAULT"/);
  assert.match(script, /自動Failoverではありません/);
  assert.match(script, /expectedCurrentOwner: group\.ownerProfileId/);
  assert.match(script, /expectedReceiverGeneration: group\.generation/);
  assert.match(script, /confirmed: true/);
  assert.equal((script.match(/type: "SET_RECEIVER_OWNER"/g) ?? []).length, 1);
  assert.doesNotMatch(script, /STALE_STATE[^\n]+SET_RECEIVER_OWNER/);
});

test("desktop MIX exposes only the active VC MIX send layer while physical mapping stays in ROUTE", () => {
  for (const className of [
    "bus-send-toggle",
    "bus-send-fader",
    "bus-send-number",
  ]) assert.match(html, new RegExp(`class="[^"]*${className}`), `missing desktop BUS control .${className}`);
  assert.match(html, /VC MIX MASTER/);
  assert.match(script, /channel\.vcSends\?\.\[bus\.id\]/);
  assert.match(script, /type: "SET_VC_SEND"/);
  assert.match(script, /type: "SET_BUS_MUTE"/);
  assert.match(script, /candidate\.linkedDiscordVoiceChannelId === voiceChannelId/);
  assert.doesNotMatch(script, /currentSnapshot\.buses\[0\]/);
  assert.match(html, /id="group-bus-members"/, "VC structure controls stay in ROUTE, outside MIX");
  assert.doesNotMatch(html, /id="bus-processing-controls"/, "retired MIX detail controls are removed");
});

test("compact Bot rows show configuration and live state without changing connections or locks", () => {
  const makeCard = (id: string) => {
    const fields: Record<string, any> = {};
    for (const name of ["id", "enabled", "token", "guildId", "voiceChannelId"]) fields[`[data-setting="${name}"]`] = { value: name === "id" ? id : name === "token" ? "" : "123", checked: true };
    for (const name of ["runtime-state", "guild-name", "voice-name"]) fields[`[data-field="${name}"]`] = {};
    for (const name of ["connect", "disconnect", "remove"]) fields[`[data-action="${name}"]`] = { classList: { toggle() {} } };
    return {
      dataset: { tokenConfigured: "true" } as Record<string, string>, fields,
      querySelector: (selector: string) => fields[selector],
      querySelectorAll: () => Object.entries(fields).filter(([name]) => name.includes("data-setting")).map(([, field]) => field),
    };
  };
  const cards = [makeCard("rx1"), makeCard("rx2"), makeCard("rx3")];
  const state = { state: "SETUP", discord: { bots: [{ profileId: "rx1", health: "READY", guildName: "Server", voiceChannelName: "Team 1" }, { profileId: "rx2", health: "FAULT" }], availableVoiceChannels: [] } };
  const context: any = {
    elements: { appPort: {}, lanAccessEnabled: {}, sharedGuildId: {}, importBotProfiles: {}, exportBotProfiles: {}, tabletEnabled: {}, tabletPort: {}, saveBotProfiles: {}, botProfileList: { querySelectorAll: () => cards } },
    botRecoveries: new Map(), settingsDirty: false, settingsLoading: false, localSettingsAvailable: true, settingsSnapshot: {},
    updateBotProfileCount() {}, updateBotProfileTxFields() {}, refreshBotProfileLocationOptions() {}, sendCommand() { assert.fail("display-only update must not send a command"); },
  };
  const start = script.indexOf("function renderSetupRuntime(");
  runInNewContext(script.slice(start, script.indexOf("\n}", start) + 2), context);
  const field = (index: number, name: string) => cards[index].fields[`[data-field="${name}"]`];
  const action = (index: number, name: string) => cards[index].fields[`[data-action="${name}"]`];
  context.renderSetupRuntime(state);
  assert.equal(field(0, "runtime-state").textContent, "接続中");
  assert.equal(cards[0].dataset.statusTone, "ready");
  assert.equal(field(0, "voice-name").textContent, "Team 1");
  assert.equal(action(0, "connect").disabled, true);
  assert.equal(action(0, "remove").disabled, true);
  assert.equal(cards[1].dataset.statusTone, "danger");
  assert.equal(action(1, "connect").textContent, "復旧");
  cards[2].dataset.tokenConfigured = "false";
  context.renderSetupRuntime(state);
  assert.equal(field(2, "runtime-state").textContent, "未設定");
  assert.equal(cards[2].dataset.statusTone, "warning");
  assert.match(field(2, "runtime-state").title, /Token/);
  cards[2].fields['[data-setting="enabled"]'].checked = false;
  cards[0].fields['[data-setting="enabled"]'].checked = false;
  context.renderSetupRuntime(state);
  assert.equal(field(2, "runtime-state").textContent, "無効");
  assert.equal(field(0, "runtime-state").textContent, "接続中", "unsaved disable does not pretend the live Bot stopped");
  context.settingsDirty = true;
  context.renderSetupRuntime(state);
  assert.equal(action(1, "connect").disabled, true);
  for (const lock of ["ON_AIR", "FAULT"]) {
    state.state = lock;
    context.renderSetupRuntime(state);
    assert.equal(context.elements.saveBotProfiles.disabled, true);
    assert.ok(cards.every((card) => card.querySelectorAll().every((input) => input.disabled)));
    assert.ok(cards.every((_, index) => action(index, "connect").disabled && action(index, "disconnect").disabled && action(index, "remove").disabled));
  }
  const template = script.slice(script.indexOf("card.innerHTML ="), script.indexOf("const setting =", script.indexOf("card.innerHTML =")));
  assert.ok(template.indexOf('data-action="remove"') > template.indexOf('<details class="bot-profile-edit">'), "delete stays inside details");
  assert.match(styles, /\.bot-profile-edit\[open\] \{ grid-column: 1 \/ -1/);
});

test("desktop SETUP manages multiple Bot profiles without exposing tokens or changing live connections on save", () => {
  for (const id of [
    "bot-profile-list",
    "bot-profile-count",
    "add-bot-profile",
    "save-bot-profiles",
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing desktop SETUP field #${id}`);
  for (const setting of ["id", "label", "role", "token", "guildId", "voiceChannelId", "enabled"]) {
    assert.match(script, new RegExp(`data-setting=["']${setting}["']`), `missing Bot card setting ${setting}`);
  }
  assert.match(script, /type="password"/);
  assert.match(script, /<option value="RX">RX（受信）<\/option><option value="TX">TX（送信）<\/option><option value="DUPLEX">RX\+TX（双方向）<\/option>/);
  assert.match(html, /Tokenは保存後に再表示されません/);
  assert.match(script, /fetch\("\/api\/settings"/);
  assert.match(script, /method: "POST"/);
  assert.match(script, /"x-dbr-session-nonce": desktopSessionNonce/);
  assert.match(script, /const bots = cards\.map\(botSettingsFromCard\)/);
  assert.match(script, /body: JSON\.stringify\(\{ bots, operator: \{ port: Number\(elements\.appPort\.value\), lanAccess: elements\.lanAccessEnabled\.checked \}, tablet: \{ enabled: elements\.tabletEnabled\.checked, port: Number\(elements\.tabletPort\.value\) \} \}\)/);
  assert.match(script, /接続中Botの状態は変更しません/);
  assert.match(script, /先にBot設定を保存してください/);
  assert.match(script, /先にこのBotを切断してください/);
  assert.match(script, /setting\("id"\)\.readOnly = true/);
  assert.match(script, /card\.querySelector\("\.bot-profile-edit"\)\.open = !persisted/);
  assert.match(script, /remove\.disabled = locked \|\| runtimeConnected/);
  assert.match(script, /type: "CONNECT_DISCORD_BOT", profileId/);
  assert.match(script, /type: "DISCONNECT_DISCORD_BOT", profileId, confirmed: true/);
  assert.match(script, /const botRecoveries = new Map\(\)/);
  assert.match(script, /phase: "disconnecting"/);
  assert.match(script, /recovery\.phase = "connecting"/);
  assert.match(script, /\["FAULT", "RECONNECTING"\]\.includes\(card\.dataset\.runtimeHealth\)/);
  assert.match(script, /health === "FAULT" \|\| health === "RECONNECTING"/);
  assert.match(script, /connect\.textContent = needsRecovery \? "復旧" : "接続"/);
  assert.match(script, /自動再試行はせず、1回だけ切断→再接続します/);
  assert.match(script, /15_000/);
  assert.match(script, /runtime\?\.guildName/);
  assert.match(script, /runtime\?\.voiceChannelName/);
  assert.match(script, /snapshot\?\.state === "ON_AIR" \|\| snapshot\?\.state === "FAULT"/);
  const saveBody = script.slice(script.indexOf("async function saveBotProfiles"), script.indexOf("function renderSetupRuntime"));
  assert.doesNotMatch(saveBody, /DISCONNECT_DISCORD_BOT|CONNECT_DISCORD_BOT/);
  assert.doesNotMatch(script, /console\.(log|info|debug)\([^\n]*token/i);
});

test("desktop SETUP owns the guarded DBR restart while STATUS only links to recovery", () => {
  for (const id of ["restart-router", "restart-detail", "status-open-recovery"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing guarded restart control #${id}`);
  }
  assert.match(script, /fetch\("\/api\/restart"/);
  assert.match(script, /body: JSON\.stringify\(\{ confirmed: true \}\)/);
  assert.match(script, /currentSnapshot\.state === "ON_AIR" \|\| currentSnapshot\.state === "FAULT" \|\| recorderState !== "IDLE"/);
  assert.match(script, /const guidance = statusGuidance\(snapshot\)/);
  assert.match(script, /showView\(guidance\.view\)/);
  const recoveryNavigation = script.slice(script.indexOf('elements.statusOpenRecovery.addEventListener("click"'), script.indexOf('elements.restartRouter.addEventListener'));
  assert.doesNotMatch(recoveryNavigation, /sendCommand|fetch\(/);
  assert.match(script, /物理Audio I\/OとCUEは安全のため自動復帰しません/);
  assert.match(script, /requestedView === "setup" \|\| requestedView === "settings"/);
});

test("desktop ROUTE uses input-to-TX and VC-to-OUT matrices with manual TX", () => {
  for (const id of ["vc-route-list", "route-matrix-mode", "tx-assignment-list", "io-input-device", "io-input-channels", "apply-io-input", "io-output-device", "io-output-endpoint", "refresh-io"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Input Ch → TX Bot/); assert.match(html, /物理OUTは使いません/);
  assert.match(script, /type: "SET_TX_INPUT", profileId, channelId/);
  assert.match(script, /type: "START_TX", profileId, confirmed: true/);
  assert.match(script, /type: "STOP_TX", profileId, confirmed: true/);
  assert.equal((script.match(/type: "START_TX"/g) ?? []).length, 1);
  assert.doesNotMatch(script, /type: "SET_TX_SOURCE"/);
  assert.match(script, /type: "SELECT_INPUT_DEVICE", deviceId: device\.id, channelCount, windowsEndpointId: endpoint\.id/);
  assert.match(script, /function autoSelectSafetyEndpoint/);
  assert.match(script, /function applyMatrixDirect/);
  assert.match(script, /function applyRouteOutput/);
});

test("pending participant keeps the pre-gate input meter visible and approval is compare-and-set", () => {
  assert.match(script, /channel\.inputMeter \?\? channel\.meter/);
  assert.doesNotMatch(html, /processed-meter/);
  assert.match(script, /channel\.approvalGateOpen !== true/);
  assert.match(script, /expectedSessionGeneration: session\.sessionGeneration/);
  assert.match(script, /expectedApprovalRevision: session\.approvalRevision/);
  assert.match(script, /message\.payload\.code === "STALE_STATE"/);
  assert.doesNotMatch(script, /STALE_STATE[^\n]+sendCommand/);
});

test("desktop MIX prefers the current Discord display name over a retained channel label", () => {
  assert.match(script, /function participantDisplayName\(currentSnapshot, channel\)/);
  assert.match(script, /profile\?\.displayName \|\| channel\.label/);
  assert.match(script, /refs\.name\.textContent = displayName/);
});

test("desktop MIX filters participants while keeping every VC master visible", () => {
  assert.match(html, /id="mix-bot-filter"/);
  assert.match(html, /class="participant-scope"/);
  assert.match(script, /let selectedMixBotProfileId = "all"/);
  assert.match(script, /const choices = \[\{ profileId: "all", label: "すべて" \}/);
  assert.match(script, /visibleParticipants\(currentSnapshot, bot, showAll\)/);
  assert.match(script, /refs\.scope\.textContent = .*bot\?\.label.*bot\?\.voiceChannelName/);
  assert.match(script, /const buses = currentSnapshot\.buses/);
  assert.match(script, /elements\.masterPanel\.hidden = buses\.length === 0/);
  assert.match(script, /for \(const bus of buses\)/);
});

test("desktop MIX replaces a held stale Bot generation with the current READY generation", () => {
  assert.match(script, /held\.health !== "STALE" && held\.health !== "DISCONNECTED"/);
  assert.match(script, /bots\.find\(\(bot\) => bot\.health === "READY"\)/);
  assert.match(script, /bots\.find\(\(bot\) => bot\.health !== "STALE" && bot\.health !== "DISCONNECTED"\)/);
  assert.match(script, /primaryBotKey = chosen\?\.key \?\? null/);
});

test("participant DOM, selection and faders stay stable across 50 ms meter renders", () => {
  assert.match(script, /const stripRefs = new Map\(\)/);
  assert.match(script, /if \(!stripRefs\.has\(channel\.id\)\) createStrip\(channel\)/);
  assert.match(script, /selectedChannelId/);
  assert.match(script, /activeFaders/);
  assert.match(script, /pendingFaders/);
  assert.match(script, /requestAnimationFrame/);
  assert.match(script, /performance\.now\(\) \+ 1400/);
  assert.match(script, /function bindFader\(input, numberInput, keyFactory, commandFactory\)/);
  assert.match(script, /numberInput\.addEventListener\("focus", activateNumber\)/);
  assert.match(script, /numberInput\.addEventListener\("keydown"/);
  assert.match(script, /numberInput\.addEventListener\("blur", finishNumber\)/);
  assert.match(script, /queueFaderCommand\(key, db, commandFactory, true\)/);
  assert.doesNotMatch(script, /participants\.(?:innerHTML|replaceChildren)/);
  assert.match(styles, /\.participant\.selected/);
  assert.match(html, /id="mix-bank-prev"/);
  assert.match(html, /id="mix-bank-next"/);
  assert.match(script, /const MIX_BANK_SIZE = 16/);
  assert.match(script, /refs\.node\.hidden = !bankIds\.has\(channel\.id\)/);
  assert.match(script, /mixBankIndex \* MIX_BANK_SIZE/);
  assert.match(styles, /grid-template-columns: repeat\(16, minmax\(104px, 1fr\)\)/);
  assert.match(html, /class="approval-controls"/);
  assert.match(styles, /\.approval-controls\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/s);
  assert.match(styles, /\.approval-state\s*\{[^}]*border: 1px solid transparent/s);
  assert.match(styles, /\.approval-state\.pending\s*\{[^}]*background: #30240d/s);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(html, /class="strip-switches"/);
  assert.match(html, /class="bus-send-toggle channel-toggle"/);
  assert.match(html, /class="meter-scale"/);
  assert.match(html, /Peak meter scale in dBFS/);
  assert.match(html, /class="fader-scale"/);
  assert.match(html, /--scale-position: 22%">0/);
  assert.match(html, /class="level-number strip-level-number"/);
  assert.match(styles, /\.strip-level-number\s*\{[^}]*grid-column: 1 \/ -1/s);
  assert.match(styles, /\.strip-switches\s*\{[^}]*grid-template-columns: 1fr 1fr/s);
  assert.ok(html.indexOf('class="strip-body"') < html.indexOf('class="strip-switches"'));
  assert.match(styles, /grid-template-columns: 20px 18px/);
  assert.match(styles, /var\(--red\) 95% 100%/);
  assert.match(styles, /writing-mode: vertical-lr/);
  assert.match(styles, /transition: height 40ms linear/);
  assert.match(serverSource, /broadcastWebSocket\(websocketClients, \(\) => \(\{ type: "meters", payload: control\.meterSnapshot\(\) \}\)\), 50/);
  assert.match(script, /render\(mergeMeterSnapshot\(snapshot, message\.payload\)\)/);
  assert.equal((styles.match(/transition: width 40ms linear/g) ?? []).length, 1);
});

test("desktop MIX reuses guarded Application and Emergency controls while physical output requires explicit SETUP confirmation", () => {
  assert.match(script, /output\?\.selectedDeviceId/);
  assert.match(script, /output\?\.activeChannelCount/);
  assert.match(script, /currentSnapshot\.emergencyMuted/);
  assert.match(html, /出力: 確認中/);
  assert.match(script, /output\?\.state === "FAULT" \? "danger" : physicalOpen \? "ready" : "safe"/);
  assert.match(script, /自動Fallback・自動再開は行いません/);
  assert.match(script, /if \(!confirm\(prompt\)\) return;/);
  assert.match(html, /id="application-control"/);
  assert.match(html, /id="emergency-state"[^>]+type="button"/);
  assert.match(script, /type: "EMERGENCY_MUTE", active: true/);
  assert.match(script, /expectedEmergencyEpoch: snapshot\.emergencyEpoch/);
  assert.match(script, /outputDevice\?\.backend === "mock"/);
  assert.match(script, /type: "SELECT_OUTPUT_DEVICE", deviceId: outputDevice\.id/);
  assert.match(script, /type: "SET_STATE", state: "SETUP", confirmed: true/);
  assert.match(script, /type: "SET_STATE", state: "READY"/);
  assert.match(script, /物理出力は開かず/);
  assert.match(script, /Audio I\/Oで出力を明示的に再選択してから解除してください/);
  assert.match(script, /type: "ACKNOWLEDGE_FAULT", confirmed: true/);
  assert.match(html, /設定ロック: 確認中/);
  assert.match(script, /設定ロック: \$\{productionLocked \? "ON" : "OFF"\}/);
  assert.match(script, /受信: \$\{failedCount\} VC停止/);
  assert.match(script, /システム: 正常/);
  assert.match(script, /type: "SET_STATE", state: locking \? "ON_AIR" : "SETUP", confirmed: true/);
  assert.doesNotMatch(script, />Profile ID</);
  assert.match(script, /Emergency Muteは解除されません/);
});

test("audio scheduler compensates ordinary timer drift without unbounded catch-up", () => {
  assert.match(serverSource, /const MAX_AUDIO_CATCH_UP_BLOCKS = 12/);
  assert.match(serverSource, /while \(now >= nextAudioBlockAt && processed < MAX_AUDIO_CATCH_UP_BLOCKS\)/);
  assert.match(serverSource, /nextAudioBlockAt \+= blockIntervalMs/);
  assert.match(serverSource, /nextAudioBlockAt = now \+ blockIntervalMs/);
  assert.match(serverSource, /setTimeout\(scheduleAudioBlock, delayMs\)\.unref\(\)/);
  assert.doesNotMatch(serverSource, /setInterval\(\(\) => \{\s*engine\.processBlock\(\)/);
});
