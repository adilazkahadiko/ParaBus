import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  tagName: string; children: Element[] = []; parent?: Element; dataset: Record<string, string> = {};
  attributes: Record<string, string> = {}; listeners: Record<string, (event: any) => void> = {};
  elements: Record<string, Element> = {}; value: any = ''; textContent = ''; type = ''; name = ''; disabled = false; checked = false;
  className = ''; classes = new Set<string>(); classList = { toggle: (key: string, value: boolean) => value ? this.classes.add(key) : this.classes.delete(key) };
  constructor(tag = 'div') { this.tagName = tag; }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Element[]) { this.children = []; this.append(...nodes); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(key: string, fn: (event: any) => void) { this.listeners[key] = fn; }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(s => this.matches(s.trim()));
    if (selector === 'input:checked') return this.tagName === 'input' && this.checked;
    const attribute = selector.match(/^\[([^=\]]+)(?:=([^\]]+))?\]$/);
    if (attribute) {
      const key = attribute[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return attribute[1].startsWith('data-') ? this.dataset[key] !== undefined : (this as any)[key] === attribute[2];
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): Element { return this.querySelectorAll(selector)[0]; }
  closest(selector: string): Element | undefined { return this.matches(selector) ? this : this.parent?.closest(selector); }
  contains(node?: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
  emit(type: string, target = this, extra: any = {}) { this.listeners[type]?.({ target, button: 0, detail: 1, preventDefault() {}, ...extra }); }
}

function fixture(count = 1, sourceCount = 3) {
  const root = new Element(), panels = new Element(), form = new Element('form'), members = new Element('fieldset');
  panels.dataset.selectorPanels = ''; members.dataset.selectorMembers = ''; root.append(panels, form); form.append(members);
  for (const name of ['selectorId', 'name', 'output', 'outputMode', 'mode', 'fadeMs']) {
    const field = new Element(['selectorId', 'outputMode', 'mode'].includes(name) ? 'select' : 'input'); field.name = name; form.elements[name] = field; form.append(field);
  }
  const submit = new Element('button'); submit.type = 'submit'; const remove = new Element('button'); remove.dataset.selectorRemove = ''; form.append(submit, remove);
  const calls: any[] = []; let now = 0, nextId = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  const context: any = {
    document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('text'), { textContent: text }) },
    Option: class extends Element { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } },
    setTimeout: (fn: () => void, delay: number) => { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; }, clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(readFileSync(new URL('../services/router-core-sim/public/output-selectors.js', import.meta.url), 'utf8').replace(/^export /gm, ''), context);
  const render = context.createOutputSelectorControls(root, (command: any) => calls.push(JSON.parse(JSON.stringify(command))), { confirmAction: () => true });
  const sources = Array.from({ length: sourceCount }, (_, i) => ({ id: `bus-${i}`, label: `Team ${i}`, groupSourceIds: null }));
  const selectors = Array.from({ length: count }, (_, i) => ({ id: `selector-${i}`, label: `Selector ${i}`, selector: { mode: 'SWITCH', fadeMs: 300, sourceBusIds: sources.map(bus => bus.id), selectedBusIds: ['bus-0'], primaryBusId: 'bus-0' },
    masterDb: 0, mute: false, meter: { peak: .1 }, limiterEnabled: true, limiterGainReductionDb: 0, physicalOutputs: [{ output: i }] }));
  const snapshot: any = { state: 'SETUP', buses: [...sources, ...selectors], channels: Array.from({ length: 60 }, () => ({})), emergencyMuted: false };
  render(snapshot);
  const tick = (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  const buttons = () => panels.children[0].children[2].children;
  return { root, panels, form, members, selectors, snapshot, render, calls, tick, buttons, submit, remove };
}

test('selector UI clicks, 500ms long press, cancellation, keyboard add/remove and OFF use compact commands', () => {
  const f = fixture(), button = f.buttons()[1];
  f.panels.emit('click', button); assert.deepEqual(f.calls.pop(), { type: 'SELECT_OUTPUT_SELECTOR', selectorId: 'selector-0', busId: 'bus-1', operation: 'SWITCH' });
  f.panels.emit('pointerdown', button); f.tick(499); assert.equal(f.calls.length, 0);
  f.tick(1); assert.equal(f.calls[0].operation, 'ADD');
  f.panels.emit('pointerup', button); f.panels.emit('click', button); assert.equal(f.calls.length, 1, 'long press must not also switch');
  f.selectors[0].selector.selectedBusIds.push('bus-1'); f.render(f.snapshot);
  f.panels.emit('click', button, { detail: 0, shiftKey: true }); assert.equal(f.calls.at(-1).operation, 'REMOVE');
  f.calls.length = 0; f.panels.emit('pointerdown', button); f.panels.emit('pointercancel', button); f.tick(600); assert.equal(f.calls.length, 0);
  f.panels.emit('pointerdown', button); f.render(f.snapshot, false); f.tick(600); assert.equal(f.calls.length, 0);
  f.render(f.snapshot, true); f.panels.emit('click', f.panels.children[0].children[3]); assert.equal(f.calls.at(-1).type, 'OUTPUT_SELECTOR_OFF');
  f.selectors[0].selector.mode = 'ADDITIVE'; f.render(f.snapshot); f.panels.emit('click', f.buttons()[0]); assert.equal(f.calls.at(-1).operation, 'TOGGLE');
});

test('8 × 20 selector controls preserve DOM, focus and form edits across 60-person meter updates', () => {
  const f = fixture(8, 20); assert.equal(f.panels.children.length, 8);
  const panel = f.panels.children[0], button = f.buttons()[0]; f.form.elements.name.value = 'Unsubmitted edit';
  for (let i = 0; i < 100; i++) { f.selectors[0].meter.peak = i / 100; f.render(f.snapshot); }
  assert.equal(f.panels.children[0], panel); assert.equal(f.buttons()[0], button); assert.equal(f.form.elements.name.value, 'Unsubmitted edit');
  assert.equal(button.attributes['aria-pressed'], 'true');
  f.selectors[0].selector.selectedBusIds.push('bus-1'); f.render(f.snapshot);
  assert.equal(button.classes.has('additional'), false); assert.equal(f.buttons()[1].classes.has('additional'), true); assert.match(panel.children[1].textContent, /追加あり/);
  f.selectors[0].selector.primaryBusId = 'bus-1'; f.render(f.snapshot);
  assert.equal(button.classes.has('additional'), true); assert.equal(f.buttons()[1].classes.has('additional'), false);
  f.snapshot.state = 'ON_AIR'; f.render(f.snapshot);
  assert.equal(f.form.elements.name.disabled, true); assert.equal(button.disabled, false); assert.equal(panel.children[7].disabled, true);
  f.panels.emit('click', f.buttons()[2]); assert.equal(f.calls.at(-1).operation, 'SWITCH');
});

test('SETUP form exposes settings and excludes groups/selectors as sources; READY locks structure', () => {
  const f = fixture(); assert.equal(f.members.children.length, 3);
  f.form.elements.name.value = 'Observer'; f.form.elements.output.value = '3'; f.form.elements.outputMode.value = 'DUAL_MONO';
  f.form.elements.mode.value = 'ADDITIVE'; f.form.elements.fadeMs.value = '500'; f.members.children[0].children[0].checked = true;
  f.form.emit('submit'); assert.deepEqual(f.calls.pop(), { type: 'CREATE_OUTPUT_SELECTOR', name: 'Observer', output: 2, outputMode: 'DUAL_MONO', mode: 'ADDITIVE', fadeMs: 500, sourceBusIds: ['bus-0'], allowCollision: false, confirmed: false });
  f.snapshot.state = 'READY'; f.render(f.snapshot); assert.equal(f.submit.disabled, true);
  f.form.emit('submit'); assert.equal(f.calls.length, 0);
  f.snapshot.state = 'SETUP'; f.render(f.snapshot); f.form.elements.selectorId.value = 'selector-0'; f.form.elements.selectorId.emit('change');
  assert.equal(f.form.elements.name.value, 'Selector 0'); f.remove.emit('click'); assert.equal(f.calls.at(-1).type, 'REMOVE_OUTPUT_SELECTOR');
});
