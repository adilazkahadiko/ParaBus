import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  value = ""; textContent = ""; className = ""; type = ""; disabled = false;
  children: Element[] = []; fields = new Map<string, Element>(); listeners = new Map<string, (() => void)[]>();
  ownerDocument: any;
  constructor(document?: any) { this.ownerDocument = document; }
  set innerHTML(_value: string) { throw new Error("HTML interpretation is forbidden"); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  querySelector(selector: string) { if (!this.fields.has(selector)) this.fields.set(selector, new Element(this.ownerDocument)); return this.fields.get(selector)!; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  emit(name: string) { if (name === "click" && this.disabled) return; for (const fn of this.listeners.get(name) ?? []) fn(); }
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(local = true) {
  const document = { createElement: () => new Element(document), querySelector: () => ({ content: "fixture-nonce" }) };
  const root = new Element(document), requests: { path: string; body: any; headers: any }[] = [], confirmations: string[] = [];
  let rows = Array.from({ length: 60 }, (_, index) => ({ discordUserId: String(700000000000000000n + BigInt(index)), displayName: index ? `Fixture ${index}` : "<b>Fixture</b>", updatedAt: "2026-11-21T00:00:00Z" }));
  let approved = true, fail = false;
  const source = readFileSync(new URL("../services/router-core-sim/public/participant-data.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const mount = runInNewContext(source + "; mountParticipantData", {});
  const api = mount(root, async (path: string, options: any) => {
    const body = JSON.parse(options.body); requests.push({ path, body, headers: options.headers });
    if (path.endsWith("/list")) return { ok: true, json: async () => ({ ok: true, participants: rows }) };
    if (fail) return { ok: false, json: async () => ({ ok: false, error: "保存を完了できませんでした" }) };
    if (path.endsWith("/delete")) rows = rows.filter(row => row.discordUserId !== body.discordUserId);
    return { ok: true, json: async () => ({ ok: true, message: "削除しました" }) };
  }, local, (text: string) => { confirmations.push(text); return approved; });
  return { root, requests, confirmations, api, approve(value: boolean) { approved = value; }, fail(value: boolean) { fail = value; } };
}
test("sixty participants render as text with complete searchable IDs and only one initial request", async () => {
  const f = fixture(); await settle();
  const list = f.root.querySelector("[data-participant-list]");
  assert.equal(list.children.length, 60); assert.equal(f.requests.length, 1);
  assert.equal(list.children[0].children[0].textContent.includes("<b>Fixture</b>"), true);
  assert.equal(list.children.every(row => /Discord ID: \d{18}/.test(row.children[0].textContent)), true);
  const search = f.root.querySelector("[data-participant-search]");
  search.value = "Fixture 59"; search.emit("input"); assert.equal(list.children.length, 1);
  search.value = String(700000000000000000n); search.emit("input"); assert.equal(list.children.length, 1);
  assert.equal(f.requests.length, 1);
});
test("confirmation identifies the participant, warns about exclusions and updates the list only after success", async () => {
  const f = fixture(); await settle(); const list = f.root.querySelector("[data-participant-list]");
  f.approve(false); list.children[0].children[1].emit("click"); await settle(); assert.equal(f.requests.length, 1);
  assert.equal(f.confirmations[0].includes("元に戻せません。録音ファイル、トレイのログ、バックアップ、ほかのPCにあるコピーは削除されません。"), true);
  assert.equal(f.confirmations[0].includes(String(700000000000000000n)), true);
  f.approve(true); list.children[0].children[1].emit("click"); await settle();
  assert.equal(list.children.length, 59);
  assert.equal(f.requests[1].path, "/api/participant-data/delete");
  assert.equal(f.requests[1].body.confirmed, true);
  assert.equal(f.requests.every(request => request.headers["x-dbr-session-nonce"] === "fixture-nonce"), true);
});
test("purge has a distinct all-participants confirmation and failed writes never display deletion success", async () => {
  const f = fixture(); await settle(); f.fail(true);
  f.root.querySelector("[data-participant-purge]").emit("click"); await settle();
  assert.equal(f.confirmations[0].includes("全員分"), true);
  assert.equal(f.requests[1].path, "/api/participant-data/delete-diagnostics");
  assert.equal(f.root.querySelector("[data-participant-status]").textContent === "保存を完了できませんでした", true);
  assert.equal(f.root.querySelector("[data-participant-list]").children.length, 60);
  assert.equal(f.root.querySelector("[data-participant-purge]").disabled, false);
});
test("LAN or tablet-style views neither fetch nor delete participant data", async () => {
  const f = fixture(false); await settle();
  f.root.querySelector("[data-participant-purge]").emit("click"); await f.api.refresh();
  assert.equal(f.requests.length, 0); assert.equal(f.confirmations.length, 0);
});
