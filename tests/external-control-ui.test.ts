import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  textContent = ""; open = false; hidden = false; disabled = false; checked = false; value: any = ""; type = "";
  children: any[] = []; elements: Element[] = []; listeners = new Map<string, (...args: any[]) => any>();
  append(...values: any[]) { this.children.push(...values); }
  replaceChildren() { this.children = []; }
  addEventListener(type: string, callback: (...args: any[]) => any) { this.listeners.set(type, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  emit(type: string) { this.listeners.get(type)?.({ preventDefault() {} }); }
}
const script = readFileSync(new URL("../services/router-core-sim/public/external-control.js", import.meta.url), "utf8").replace("export function", "function");
test("desktop external UI displays token only once, uses text nodes, clears on hide/close and leaves B ungrantable", async () => {
  const elements = new Map<string, Element>(), $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: any[] = [], documentEvents = new Map<string, () => void>(), timers: Array<() => void> = [];
  let state = "SETUP";
  const document: any = { hidden: false, activeElement: null, getElementById: $, querySelector: () => ({ content: "fake-desktop-nonce" }),
    addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback), createElement: () => new Element(), createTextNode: (text: string) => ({ textContent: text }) };
  const context: any = { document, window: { addEventListener() {} }, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    fetch: async (_url: string, options: any) => {
      const input = JSON.parse(options.body); requests.push({ input, headers: options.headers });
      return { ok: true, json: async () => ({ ok: true, data: input.action === "register" ? { token: "SYNTHETIC_ISSUANCE_ONLY" } : input.action === "status" ? {
        enabled: false, available: true, state, port: 4175, activePort: 4175, url: "http://127.0.0.1:4175/external/v1", activeDeviceCount: 1, activeDeviceNames: ["<img>"],
        devices: [{ deviceId: "fake-id", name: "<img onerror=alert(1)>", revoked: false, readDisplayNames: false, allowedTierBOperations: [] }] } : {} }) };
    } };
  runInNewContext(script + "\nmountExternalControl(true);", context);
  const flush = () => new Promise(resolve => setImmediate(resolve)); await flush();
  assert.match($("external-control-status").textContent, /接続中 1 台/);
  const row = $("external-control-devices").children[0]; assert.equal(row.children[0].textContent.includes("<img onerror=alert(1)>"), true);
  $("external-control-name").value = "Device"; $("external-control-register").emit("submit"); await flush();
  assert.equal($("external-control-token-dialog").open, true); assert.equal($("external-control-token").textContent, "SYNTHETIC_ISSUANCE_ONLY");
  assert.equal(requests.filter(r => r.input.action === "register").length, 1);
  document.hidden = true; documentEvents.get("visibilitychange")!(); assert.equal($("external-control-token").textContent, ""); assert.equal($("external-control-token-dialog").open, false);
  assert.ok(requests.every(r => r.headers["x-dbr-session-nonce"] === "fake-desktop-nonce")); assert.ok(requests.every(r => !JSON.stringify(r.input).includes("SYNTHETIC_ISSUANCE_ONLY")));
  state = "FAULT"; document.hidden = false; timers[0](); await flush(); assert.equal($("external-control-enable").disabled, true);
  $("external-control-stop").emit("click"); await flush(); assert.ok(requests.some(r => r.input.action === "stop"));
  assert.equal(requests.some(r => "allowedTierBOperations" in r.input), false);
});

test("remote desktop does not request external management or mount token controls", () => {
  runInNewContext(script + "\nmountExternalControl(false);", { fetch() { throw new Error("Remote UI must not request management"); }, document: { getElementById() { throw new Error("Remote UI must not mount management"); } } });
  const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="external-control-stop"[^>]*data-local-only/); assert.match(html, /id="external-control-setup"[^>]*data-local-only/);
});
