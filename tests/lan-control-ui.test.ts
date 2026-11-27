import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
class Element {
  children: Element[] = []; elements: Element[] = []; dataset: Record<string, string> = {}; listeners: Record<string, (event: any) => unknown> = {};
  textContent = ''; value: any = ''; checked = false; disabled = false; hidden = false; open = false; type = ''; rows = 0;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener(type: string, callback: (event: any) => unknown) { this.listeners[type] = callback; }
  emit(type: string) { return this.listeners[type]?.({ preventDefault() {} }); }
}
test('LAN SETUP preserves drafts, displays persistent status, saves explicit scopes and only copies masked codes to clipboard', async () => {
  const elements = new Map<string, Element>(), $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const state: any = { enabled: false, address: '', addresses: ['192.0.2.1'], port: 4176, listening: false, state: 'SETUP', fingerprint: null,
    selectors: [{ selectorId: 'public-selector', name: '<Director>' }], devices: [{ deviceId: 'device', name: '<Device>', revoked: false, enabled: false, addresses: [], selectorIds: [], groups: [] }] };
  const requests: any[] = [], copies: string[] = [], timers: Array<() => unknown> = [], confirmations: string[] = [];
  const form = $('lan-control-form'); form.elements = [$('lan-control-enabled'), $('lan-control-address'), $('lan-control-port'), new Element()];
  const context: any = { document: { hidden: false, activeElement: null, getElementById: $, querySelector: () => ({ content: 'test-nonce' }), createElement: () => new Element(), createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }) },
    Option: class extends Element { constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; } },
    setTimeout: (callback: () => unknown) => timers.push(callback), confirm: (message: string) => { confirmations.push(message); return true; }, fetch: async () => {},
  };
  const fetch = async (_url: string, options: any) => {
    const value = JSON.parse(options.body); requests.push(value);
    if (value.action === 'configure') Object.assign(state, value, { listening: value.enabled, fingerprint: '0'.repeat(64) });
    if (value.action === 'scope') Object.assign(state.devices[0], value.scope);
    if (value.action === 'stop') Object.assign(state, { enabled: false, listening: false });
    return { ok: true, json: async () => ({ ok: true, data: value.action === 'connection-code' ? { connectionCode: 'parabus1:SYNTHETIC_CLIPBOARD_ONLY' } : state }) };
  };
  runInNewContext(readFileSync(new URL('../services/router-core-sim/public/lan-control.js', import.meta.url), 'utf8').replace(/^export /gm, ''), context);
  context.mountLanControl(true, fetch, { writeText: async (value: string) => copies.push(value) });
  const flush = () => new Promise(resolve => setImmediate(resolve)); await flush();
  $('lan-control-enabled').checked = true; $('lan-control-address').value = '192.0.2.1'; $('lan-control-port').value = '44176'; form.emit('submit'); await flush();
  assert.ok(requests.some(request => request.enabled === true && request.address === '192.0.2.1' && request.port === 44176)); assert.equal($('lan-control-badge').hidden, false);
  const row = $('lan-control-devices').children[0]; assert.equal(row.children[0].textContent, '<Device>');
  row.children[1].children[0].checked = true; row.children[2].children[1].value = '192.0.2.10'; row.children[3].children[1].children[0].checked = true;
  row.children[5].emit('click'); await flush();
  const scope = requests.find(request => request.action === 'scope').scope; assert.deepEqual(scope, { enabled: true, addresses: ['192.0.2.10'], selectorIds: ['public-selector'], groups: [] });
  const fresh = $('lan-control-devices').children[0]; fresh.children[2].children[1].value = '192.0.2.11'; timers.at(-1)!(); await flush();
  assert.equal($('lan-control-devices').children[0], fresh); assert.equal(fresh.children[2].children[1].value, '192.0.2.11');
  await fresh.children[7].emit('click'); await flush(); assert.equal(copies.length, 1);
  assert.ok(!JSON.stringify([...elements.values()]).includes(copies[0])); assert.ok(!JSON.stringify(requests).includes(copies[0]));
  assert.match($('lan-control-message').textContent, /人に見せない・チャットに貼らない/);
  $('lan-control-rotate').emit('click'); await flush(); assert.ok(confirmations.some(message => message.includes('すべての機器') && message.includes('貼り直す')));
  state.state = 'ON_AIR'; timers.at(-1)!(); await flush(); assert.ok(form.elements.every(input => input.disabled)); assert.equal($('lan-control-stop').disabled, false);
  $('lan-control-stop').emit('click'); await flush(); assert.equal($('lan-control-badge').hidden, true);
});
