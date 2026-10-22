import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = readFileSync(new URL("../services/router-core-sim/tablet-public/tablet.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../services/router-core-sim/tablet-public/index.html", import.meta.url), "utf8");

class Element {
  value = ""; textContent = ""; innerHTML = ""; className = ""; disabled = false; hidden = false;
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; attributes: Record<string, string> = {};
  children: Element[] = []; fields = new Map<string, Element>(); parent?: Element;
  listeners = new Map<string, (event?: any) => void>(); classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, active: boolean) => active ? this.classes.add(name) : this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  append(node: Element) { this.children.push(node); node.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  querySelector(selector: string) { if (!this.fields.has(selector)) this.fields.set(selector, new Element()); return this.fields.get(selector)!; }
  querySelectorAll(selector: string) { return [...this.fields.entries()].filter(([key]) => selector === "button, input" && (key.startsWith("input") || key === ".mute" || key === ".cue")).map(([, value]) => value); }
  addEventListener(type: string, listener: (event?: any) => void) { this.listeners.set(type, listener); }
  fire(type: string) { if (!this.disabled) this.listeners.get(type)?.({ target: this }); }
}

function tablet() {
  const elements = new Map<string, Element>();
  const views = ["mix", "masters", "monitor", "recorder", "scenes"].map(page => Object.assign(new Element(), { dataset: { page }, hidden: page !== "mix" }));
  const nav = views.map(view => Object.assign(new Element(), { dataset: { view: view.dataset.page } }));
  const commands: any[] = [];
  class Socket {
    static OPEN = 1; readyState = 1;
    send(value: string) { commands.push(JSON.parse(value).payload); }
  }
  const document = { activeElement: null as Element | null, createElement: () => new Element(),
    querySelector(selector: string) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector)!; },
    querySelectorAll: (selector: string) => selector === "nav button" ? nav : views,
  };
  const context: any = { document, WebSocket: Socket, fetch: async () => ({ ok: false }), setTimeout: () => 1, clearTimeout() {} };
  runInNewContext(`${script}\nthis.ui = {
    accept(data) { snapshot = data; renderMasters(data); },
    connect(connected) { socket.readyState = connected ? WebSocket.OPEN : 3; setConnected(connected); }
  }; socket = new WebSocket(); setConnected(true);`, context);
  return { ui: context.ui, list: elements.get("#vc-master-list")!, document, commands, nav, views };
}

function bus(id: string, label: string) {
  return { id, label, masterDb: -6, mute: false, meter: { peak: 0, loudnessMomentary: -18 }, inputMeter: { peak: 0.5 } };
}

test("Tablet VC masters display three buses and send master, MUTE and single CUE commands without overwriting focused controls", () => {
  const { ui, list, document, commands, nav, views } = tablet();
  const data = { buses: [bus("tablet-bus-1", "VC 01"), bus("tablet-bus-2", "VC 02"), bus("tablet-bus-3", "Manual")], monitorSourceId: null as string | null,
    discord: { bots: [{ role: "RX", label: "Team 01", voiceChannelName: "VC 01" }, { role: "TX", label: "Not RX", voiceChannelName: "VC 02" }] } };
  ui.accept(data);
  assert.equal(list.children.length, 3);
  nav[1].fire("click"); assert.equal(views[1].hidden, false); assert.equal(views[0].hidden, true);
  assert.match(html, /data-view="masters">VCマスター/);
  const [first, second] = list.children;
  assert.equal(first.querySelector("h2").textContent, "Team 01");
  assert.equal(first.querySelector("small").textContent, "VC 01");
  assert.equal(second.querySelector("h2").textContent, "VC 02", "TX-only Bot names do not relabel RX buses");
  const range = first.querySelector('input[type="range"]'), number = first.querySelector('input[type="number"]');
  range.value = "-9"; range.fire("input");
  assert.deepEqual(commands.at(-1), { type: "SET_BUS_MASTER", busId: "tablet-bus-1", db: -9 });
  number.value = "4.5"; number.fire("change");
  assert.deepEqual(commands.at(-1), { type: "SET_BUS_MASTER", busId: "tablet-bus-1", db: 4.5 });
  first.querySelector(".mute").fire("click");
  assert.deepEqual(commands.at(-1), { type: "SET_BUS_MUTE", busId: "tablet-bus-1", mute: true });
  data.buses[0].mute = true; data.buses[0].masterDb = 4.5; ui.accept(data);
  assert.equal(list.children[0], first, "meter updates preserve card and control DOM");
  assert.equal(range.disabled, false, "mute does not lock the fader");
  assert.equal(number.disabled, false);
  assert.ok(parseFloat(first.querySelector(".meter i").style.width) > 80, "meter is pre-master even when the output is muted");
  assert.equal(first.querySelector("[data-lufs]").textContent, "-18.0 LUFS-M");
  first.querySelector(".mute").fire("click");
  assert.deepEqual(commands.at(-1), { type: "SET_BUS_MUTE", busId: "tablet-bus-1", mute: false });
  first.querySelector(".cue").fire("click");
  assert.deepEqual(commands.at(-1), { type: "SET_PFL", sourceId: "tablet-bus-1" });
  data.monitorSourceId = "tablet-bus-1"; ui.accept(data);
  assert.equal(first.classList.contains("cue-active"), true);
  assert.equal(first.querySelector(".cue").attributes["aria-pressed"], "true");
  first.querySelector(".cue").fire("click");
  assert.deepEqual(commands.at(-1), { type: "SET_PFL", sourceId: null });
  second.querySelector(".cue").fire("click");
  assert.deepEqual(commands.at(-1), { type: "SET_PFL", sourceId: "tablet-bus-2" });
  data.monitorSourceId = "tablet-bus-2"; ui.accept(data);
  assert.equal(first.classList.contains("cue-active"), false); assert.equal(second.classList.contains("cue-active"), true);
  document.activeElement = range; range.value = "-12"; range.fire("input");
  data.buses[0].masterDb = -3; data.buses[0].inputMeter.peak = 0.1; ui.accept(data);
  assert.equal(range.value, "-12"); assert.equal(number.value, "-12.0");
  assert.ok(parseFloat(first.querySelector(".meter i").style.width) < 80);
  document.activeElement = number; number.value = "7.2"; ui.accept(data); assert.equal(number.value, "7.2");
  document.activeElement = null; ui.accept(data); assert.equal(range.value, "-3"); assert.equal(number.value, "-3.0");
  number.value = "99"; number.fire("change"); assert.deepEqual(commands.at(-1), { type: "SET_BUS_MASTER", busId: "tablet-bus-1", db: 12 });
  const count = commands.length; number.value = ""; number.fire("change"); assert.equal(commands.length, count);
  ui.connect(false);
  for (const card of list.children) for (const control of card.querySelectorAll("button, input")) assert.equal(control.disabled, true);
  first.querySelector(".cue").fire("click"); assert.equal(commands.length, count);
  first.querySelector(".cue").listeners.get("click")?.(); assert.equal(commands.length, count, "socket guard also blocks direct callbacks while offline");
  ui.connect(true); assert.equal(range.disabled, false);
});

test("Tablet master list handles 24 buses, ambiguous names, removal, and disconnected snapshot updates", () => {
  const { ui, list, commands } = tablet();
  const data = { buses: Array.from({ length: 24 }, (_, i) => bus(`tablet-bus-${i + 1}`, `VC ${i + 1}`)), monitorSourceId: null,
    discord: { bots: [{ role: "RX", label: "Guild A", voiceChannelName: "VC 1" }, { role: "RX", label: "Guild B", voiceChannelName: "VC 1" }] } };
  ui.accept(data); assert.equal(list.children.length, 24);
  assert.equal(list.children[0].querySelector("h2").textContent, "VC 1", "ambiguous VC names never select an arbitrary Bot");
  data.discord.bots = [{ role: "RX", label: "Main", voiceChannelName: "VC 1" }];
  data.buses[1].label = "VC 1"; ui.accept(data);
  assert.equal(list.children[0].querySelector("h2").textContent, "VC 1", "duplicate Bus names also prevent speculative Bot labels");
  ui.connect(false); data.buses.push(bus("tablet-bus-25", "New Bus")); ui.accept(data);
  for (const control of list.children.at(-1)!.querySelectorAll("button, input")) assert.equal(control.disabled, true);
  data.buses = data.buses.slice(1, 4); ui.accept(data);
  assert.deepEqual(list.children.map(card => card.dataset.bus), ["tablet-bus-2", "tablet-bus-3", "tablet-bus-4"]);
  assert.equal(commands.length, 0, "rendering never sends audio commands");
});
