import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  children: Element[] = []; fields = new Map<string, Element>(); listeners: Record<string, () => void> = {};
  disabled = false; hidden = false; className = ""; textContent = ""; innerHTML = ""; removed = false;
  value = ""; style: Record<string, string> = {}; attributes: Record<string, string> = {};
  parentElement: Element = this;
  classList = { toggle() {} };
  append(...nodes: Element[]) { this.children.push(...nodes); }
  querySelector(selector: string) { if (!this.fields.has(selector)) this.fields.set(selector, new Element()); return this.fields.get(selector)!; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
  click() { if (!this.disabled) this.listeners.click?.(); }
  remove() { this.removed = true; }
}

function fixture() {
  const root = new Element(), calls: any[] = [], operations: any[] = [], forgotten: string[] = [];
  const bindings = new Map<string, (db: number) => any>();
  const context: any = { document: { createElement: () => new Element() } };
  runInNewContext(readFileSync(new URL("../services/router-core-sim/public/tx-mix.js", import.meta.url), "utf8").replace(/^export /gm, ""), context);
  const render = context.createTxMixControls(root, (command: any) => calls.push(JSON.parse(JSON.stringify(command))), {
    bindFader(_fader: Element, _number: Element, key: () => string, factory: (db: number) => any) { bindings.set(key(), factory); },
    syncFader(_key: string, _fader: Element, number: Element, db: number) { number.value = db.toFixed(1); },
    forgetFader(key: string) { forgotten.push(key); },
    operate(id: string, start: boolean) { operations.push({ id, start }); },
  });
  const snapshot: any = { state: "ON_AIR", emergencyMuted: false, input: { state: "READY", selectedDeviceId: "pa:1" },
    channels: [{ id: "local-input:1", kind: "LocalMonoInput" }], discord: { txStems: [] } };
  const stem = (id: string) => ({ profileId: id, label: `自由名 ${id}`, audioMode: "MONO", sourceInputChannelId: "local-input:1", state: "READY", active: false, masterDb: 0, peak: 0 });
  return { root, list: root.querySelector(".tx-mix-list"), stop: root.querySelector(".tx-stop-all"), calls, operations, forgotten, bindings, render, snapshot, stem };
}

test("TX MIX shows only actual Bots, binds independent masters, reuses strips and stops all immediately", () => {
  const f = fixture(); f.snapshot.discord.txStems = Array.from({ length: 22 }, (_, i) => f.stem(`custom-${i}`));
  f.render(f.snapshot);
  assert.equal(f.list.children.length, 22);
  const first = f.list.children[0];
  assert.equal(first.querySelector("strong").textContent, "自由名 custom-0");
  assert.deepEqual(JSON.parse(JSON.stringify(f.bindings.get("tx:custom-0")!(-12))), { type: "SET_TX_MASTER", profileId: "custom-0", db: -12 });
  first.querySelector("button").click(); assert.deepEqual(f.operations, [{ id: "custom-0", start: true }]);
  assert.equal(f.calls.length, 0, "no ARMED or automatic START commands");
  Object.assign(f.snapshot.discord.txStems[0], { active: true, state: "SENDING", masterDb: -12, peak: 0.5 });
  f.render(f.snapshot);
  assert.equal(f.list.children[0], first, "meter refresh keeps fader DOM/focus");
  assert.equal(first.querySelector('[type="number"]').value, "-12.0");
  assert.equal(f.list.children[1].querySelector('[type="number"]').value, "0.0");
  assert.equal(first.querySelector("button").attributes["aria-pressed"], "true");
  assert.ok(parseFloat(first.querySelector(".vc-master-meter span").style.width) > 0);
  first.querySelector("button").click(); assert.deepEqual(f.operations[1], { id: "custom-0", start: false });
  f.stop.click(); assert.deepEqual(f.calls, [{ type: "CLEAR_ALL" }]);
  f.snapshot.discord.txStems = []; f.render(f.snapshot);
  assert.equal(f.root.hidden, true); assert.equal(first.removed, true); assert.equal(f.forgotten.length, 22);
  const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /tx-target-panel|tx-targets\.css/);
  assert.ok(html.indexOf('id="tx-mix-panel"') > html.indexOf('id="mix-view"'));
  assert.ok(html.indexOf('id="tx-mix-panel"') < html.indexOf('id="session-view"'));
});

test("TX MIX blocks unsafe starts, keeps stop available in FAULT, and displays configured offline Bots without placeholders", () => {
  const f = fixture(), s: any = f.stem("one"); f.snapshot.discord.txStems = [s];
  const configured = [{ id: "offline", label: "返し", role: "TX", enabled: true }, { id: "disabled", role: "TX", enabled: false }, { id: "rx", role: "RX", enabled: true }];
  f.render(f.snapshot, configured);
  assert.equal(f.list.children.length, 2);
  assert.equal(f.list.children[1].querySelector("button").disabled, true);
  assert.equal(f.list.children[1].querySelector('[type="range"]').disabled, true);
  const button = f.list.children[0].querySelector("button");
  for (const condition of ["fault", "emergency", "unassigned", "input-stopped", "not-ready", "missing-stereo-right", "disconnected"]) {
    Object.assign(s, f.stem("one")); f.snapshot.state = "ON_AIR"; f.snapshot.emergencyMuted = false; f.snapshot.input.state = "READY";
    if (condition === "fault") f.snapshot.state = "FAULT";
    if (condition === "emergency") f.snapshot.emergencyMuted = true;
    if (condition === "unassigned") s.sourceInputChannelId = null;
    if (condition === "input-stopped") f.snapshot.input.state = "STOPPED";
    if (condition === "not-ready") s.state = "NOT_READY";
    if (condition === "missing-stereo-right") s.audioMode = "STEREO";
    f.render(f.snapshot, configured, condition !== "disconnected");
    assert.equal(button.disabled, true, condition); button.listeners.click();
    assert.equal(f.operations.length, 0, condition);
  }
  Object.assign(s, { active: true, state: "SENDING" }); f.snapshot.state = "FAULT";
  f.render(f.snapshot, configured); assert.equal(button.disabled, false); button.click();
  assert.deepEqual(f.operations, [{ id: "one", start: false }]);
  f.render(f.snapshot, configured, false); f.stop.listeners.click(); assert.equal(f.calls.length, 0);
  Object.assign(s, f.stem("one")); f.snapshot.state = "READY"; f.render(f.snapshot, configured);
  assert.equal(button.textContent, "送信OFF"); assert.equal(f.operations.length, 1, "recovery never auto-starts");
});
