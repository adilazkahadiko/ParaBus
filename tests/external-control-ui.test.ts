import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  textContent = ""; open = false; hidden = false; disabled = false; checked = false; value: any = ""; type = "";
  dataset: Record<string, string> = {}; className = "";
  children: any[] = []; elements: Element[] = []; listeners = new Map<string, (...args: any[]) => any>();
  get lastElementChild() { return this.children.at(-1); }
  append(...values: any[]) { this.children.push(...values); }
  replaceChildren() { this.children = []; }
  addEventListener(type: string, callback: (...args: any[]) => any) { this.listeners.set(type, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get("close")?.(); }
  emit(type: string) { this.listeners.get(type)?.({ preventDefault() {} }); }
}
const script = readFileSync(new URL("../services/router-core-sim/public/external-control.js", import.meta.url), "utf8").replace("export function", "function");
test("desktop external UI displays token once, manages individual B grants and revoked deletion only in SETUP", async () => {
  const elements = new Map<string, Element>(), $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: any[] = [], documentEvents = new Map<string, () => void>(), timers: Array<() => void> = [];
  let state = "SETUP", permissions: string[] = [], readDisplayNames = false, revoked = false, stopSaveFailed = false, enabled = false, statusFails = false;
  const document: any = { hidden: false, activeElement: null, getElementById: $, querySelector: () => ({ content: "fake-desktop-nonce" }),
    addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback), createElement: () => new Element(), createTextNode: (text: string) => ({ textContent: text }) };
  const context: any = { document, window: { addEventListener() {} }, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    fetch: async (_url: string, options: any) => {
      const input = JSON.parse(options.body); requests.push({ input, headers: options.headers });
      if (input.action === "status" && statusFails) throw new Error("Synthetic status failure");
      if (input.action === "enable") enabled = true;
      if (input.action === "permissions") { permissions = input.allowedTierBOperations; readDisplayNames = input.readDisplayNames; }
      if (input.action === "revoke") revoked = true;
      if (input.action === "stop") stopSaveFailed = true;
      return { ok: true, json: async () => ({ ok: true, data: ["register", "reissue"].includes(input.action) ? { token: "SYNTHETIC_ISSUANCE_ONLY" } : input.action === "status" ? {
        enabled, stopSaveFailed, available: true, state, port: 4175, activePort: 4175, url: "http://127.0.0.1:4175/external/v1", activeDeviceCount: 1, activeDeviceNames: ["<img>"],
        devices: [{ deviceId: "fake-id", name: "<img onerror=alert(1)>", revoked, readDisplayNames, allowedTierBOperations: permissions }] } : {} }) };
    } };
  runInNewContext(script + "\nmountExternalControl(true);", context);
  const flush = () => new Promise(resolve => setImmediate(resolve)); await flush();
  assert.match($("external-control-status").textContent, /接続中 1 台/);
  assert.equal($("external-control-setup-status").textContent, $("external-control-status").textContent);
  const row = $("external-control-devices").children[0]; assert.equal(row.children[0].children[0].textContent.includes("<img onerror=alert(1)>"), true);
  const details = row.children[1]; assert.equal(details.open, false);
  assert.equal(details.children[0].textContent, "段階Bの許可（操作ごとに確認が必要）");
  assert.match(details.children[1].textContent, /Stream Deck プラグインでは使いません/);
  assert.equal(details.children[2].children.length, 11); // legend plus ten independent permissions, no all-operations switch.
  for (const index of [6, 7]) assert.match(details.children[2].children[index].children[1].children[0].textContent, /シーンと外部操作からだけ変更/);
  details.open = true;
  const check = details.children[2].children[1].children[0]; check.checked = true; check.emit("change"); await flush();
  assert.deepEqual(permissions, ["bus.fader.set"]);
  assert.equal($("external-control-devices").children[0].children[1].open, true, "editing a grant keeps its details expanded");
  const names = $("external-control-devices").children[0].children[0].children[1].children[0]; names.checked = true; names.emit("change"); await flush();
  assert.deepEqual(permissions, ["bus.fader.set"]); assert.equal(readDisplayNames, true);
  const revokeCheck = $("external-control-devices").children[0].children[1].children[2].children[1].children[0]; revokeCheck.checked = false; revokeCheck.emit("change"); await flush();
  assert.deepEqual(permissions, []);
  $("external-control-enable").emit("click"); await flush(); assert.ok(requests.some(r => r.input.action === "enable"));
  assert.match($("external-control-status").textContent, /有効 \/ 接続中 1 台/);
  assert.equal($("external-control-setup-status").textContent, $("external-control-status").textContent);
  $("external-control-port").value = "4180"; $("external-control-port-form").emit("submit"); await flush();
  assert.ok(requests.some(r => r.input.action === "port" && r.input.port === 4180));
  $("external-control-name").value = "Device"; $("external-control-register").emit("submit"); await flush();
  assert.equal($("external-control-token-dialog").open, true); assert.equal($("external-control-token").textContent, "SYNTHETIC_ISSUANCE_ONLY");
  assert.equal(requests.filter(r => r.input.action === "register").length, 1);
  const reissue = $("external-control-devices").children[0].children[0].children[2];
  assert.equal(reissue.textContent, "再発行"); reissue.emit("click"); await flush();
  assert.ok(requests.some(r => r.input.action === "reissue" && r.input.deviceId === "fake-id"));
  document.hidden = true; documentEvents.get("visibilitychange")!(); assert.equal($("external-control-token").textContent, ""); assert.equal($("external-control-token-dialog").open, false);
  assert.ok(requests.every(r => r.headers["x-dbr-session-nonce"] === "fake-desktop-nonce")); assert.ok(requests.every(r => !JSON.stringify(r.input).includes("SYNTHETIC_ISSUANCE_ONLY")));
  state = "FAULT"; document.hidden = false; timers[0](); await flush(); assert.equal($("external-control-enable").disabled, true);
  assert.ok($("external-control-devices").children[0].children[1].children[2].children.slice(1).every((label: any) => label.children[0].disabled));
  $("external-control-stop").emit("click"); await flush(); assert.ok(requests.some(r => r.input.action === "stop"));
  assert.match($("external-control-status").textContent, /停止済み（保存に失敗）/);
  assert.equal($("external-control-setup-status").textContent, $("external-control-status").textContent);
  state = "SETUP"; timers.at(-1)!(); await flush();
  const revoke = $("external-control-devices").children[0].children[0].children[3];
  assert.equal(revoke.textContent, "取り消し"); revoke.emit("click"); await flush();
  assert.ok(requests.some(r => r.input.action === "revoke" && r.input.deviceId === "fake-id"));
  const remove = $("external-control-devices").children[0].children[0].children[1]; assert.equal(remove.textContent, "削除"); assert.equal(remove.disabled, false);
  remove.emit("click"); await flush(); assert.ok(requests.some(r => r.input.action === "delete" && r.input.deviceId === "fake-id"));
  statusFails = true; timers.at(-1)!(); await flush();
  assert.equal($("external-control-status").textContent, "外部操作: 接続を確認してください");
  assert.equal($("external-control-setup-status").textContent, $("external-control-status").textContent);
  statusFails = false; timers.at(-1)!(); await flush();
  assert.match($("external-control-status").textContent, /接続中 1 台/);
  assert.equal($("external-control-setup-status").textContent, $("external-control-status").textContent);
});

test("remote desktop does not request external management or mount token controls", () => {
  runInNewContext(script + "\nmountExternalControl(false);", { fetch() { throw new Error("Remote UI must not request management"); }, document: { getElementById() { throw new Error("Remote UI must not mount management"); } } });
  const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="external-control-stop"[^>]*data-local-only/); assert.match(html, /id="external-control-setup"[^>]*data-local-only/);
});
