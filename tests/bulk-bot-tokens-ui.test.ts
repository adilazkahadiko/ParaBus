import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  value = ""; textContent = ""; innerHTML = ""; className = "";
  checked = false; disabled = false;
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  children: Element[] = []; fields = new Map<string, Element>();
  listeners = new Map<string, Array<() => void>>();
  classList = { toggle() {}, add() {}, remove() {} };
  setAttribute() {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  add(child: Element) { this.append(child); }
  querySelector(selector: string): Element | null {
    if (selector === ".empty-state") return null;
    if (!this.fields.has(selector)) this.fields.set(selector, new Element());
    return this.fields.get(selector)!;
  }
  querySelectorAll(selector: string): Element[] {
    if (selector === ".settings-bot-card" || selector === ".bot-profile-card") return this.children.filter((child) => `.${child.className}` === selector);
    return [...this.fields].filter(([name]) => name.startsWith("[data-setting=")).map(([, element]) => element);
  }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event: Event) { for (const listener of this.listeners.get(event.type) ?? []) listener(); }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

test("canonical bulk import fills an empty rack up to the actual 24-Bot cap", () => {
  const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  const elements = Object.fromEntries(["botProfileList", "botProfileCount", "addBotProfile", "addTxProfile", "addDuplexProfile", "addSpareProfile", "bulkBotTokens", "addBotTokens", "setupStatus", "saveBotProfiles"].map(name => [name, new Element()]));
  const notices: string[] = [];
  const context: any = { elements, Event, settingsDirty: false, settingsSnapshot: { limits: { total: 24, rx: 24, tx: 22 } }, snapshot: { state: "SETUP" },
    document: { createElement: () => new Element() }, Option: class extends Element { constructor(text: string, value: string) { super(); this.textContent = text; this.value = value; } },
    populateTxDestinations() {}, showNotice: (message: string) => notices.push(message),
  };
  const names = ["generatedTokenEnvironment", "markSettingsDirty", "nextBotProfileId", "updateBotProfileCount", "setSelectOptions", "syncControlSelect", "refreshBotProfileLocationOptions", "updateBotProfileTxFields", "createBotProfileCard", "addBotProfile", "addBotProfileTokens"];
  runInNewContext(names.map(name => { const start = script.indexOf("function " + name + "("); return script.slice(start, script.indexOf("\n}", start) + 2); }).join("\n"), context);
  const tokens = Array.from({ length: 27 }, (_, i) => "FAKE_BULK_TOKEN_" + i);
  elements.bulkBotTokens.value = tokens.join("\n");
  context.addBotProfileTokens();
  assert.equal(elements.botProfileList.children.length, 24);
  assert.equal(elements.botProfileList.children[23].querySelector('[data-setting="id"]')!.value, "RX24");
  assert.equal(elements.botProfileList.children[23].querySelector('[data-setting="token"]')!.value, tokens[23]);
  assert.equal(elements.botProfileList.children[23].querySelector('[data-setting="voiceChannelId"]')!.value, "");
  assert.equal(elements.bulkBotTokens.value, "");
  assert.equal(elements.addBotTokens.disabled, true);
  assert.equal(context.settingsDirty, true);
  assert.deepEqual(notices, ["24件追加しました（上限で3件、重複・形式不正で0件をスキップ）"]);
  for (const token of tokens) assert.equal(notices.join(" ").includes(token), false);
});

test("desktop settings bulk-add RX cards with inherited Guild only, limits, locks and count-only notices", () => {
  const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  assert.match(html, /<textarea id="bulk-bot-tokens"[^>]*autocomplete="off"[^>]*spellcheck="false"/);
  assert.ok(html.indexOf('id="bulk-bot-tokens"') < html.indexOf('id="bot-profile-list"'));
  const elements = Object.fromEntries(["botProfileList", "botProfileCount", "addBotProfile", "addTxProfile", "addDuplexProfile", "addSpareProfile", "bulkBotTokens", "addBotTokens", "setupStatus", "saveBotProfiles"].map((name) => [name, new Element()]));
  const notices: string[] = [];
  const context: any = { elements, Event, settingsDirty: false, settingsSnapshot: { limits: { total: 24, rx: 24, tx: 22 } }, snapshot: { state: "SETUP" },
    document: { createElement: () => new Element() }, Option: class extends Element { constructor(name: string, value: string) { super(); this.textContent = name; this.value = value; } },
    populateTxDestinations() {}, showNotice: (message: string) => notices.push(message),
  };
  const functions = ["generatedTokenEnvironment", "markSettingsDirty", "nextBotProfileId", "updateBotProfileCount", "setSelectOptions", "syncControlSelect", "refreshBotProfileLocationOptions", "updateBotProfileTxFields", "createBotProfileCard", "addBotProfile", "addBotProfileTokens"];
  runInNewContext(functions.map((name) => { const start = script.indexOf(`function ${name}(`); assert.ok(start >= 0); return script.slice(start, script.indexOf("\n}", start) + 2); }).join("\n"), context);
  runInNewContext(script.match(/elements\.addBotTokens\.addEventListener\("click", addBotProfileTokens\);/)![0], context);
  const setting = (card: Element, name: string) => card.querySelector(`[data-setting="${name}"]`)!;
  const existing = context.createBotProfileCard({ id: "RX02", label: "Existing Bot", role: "RX", guildId: "100000000000000001", voiceChannelId: "200000000000000001", enabled: true });
  elements.botProfileList.append(existing);
  context.updateBotProfileCount();
  const tokenA = "FAKE_DESKTOP_TOKEN_A_DO_NOT_DISPLAY", tokenB = "FAKE_DESKTOP_TOKEN_B_DO_NOT_DISPLAY";
  elements.bulkBotTokens.value = `  ${tokenA} \r\n\n${tokenA}\n ${tokenB} `;
  elements.addBotTokens.click();
  const cards = elements.botProfileList.children;
  assert.equal(cards.length, 3, "two unique tokens create two RX cards despite duplicates and blank lines");
  for (const [card, id, token] of [[cards[1], "RX01", tokenA], [cards[2], "RX03", tokenB]] as const) {
    assert.equal(setting(card, "id").value, id);
    assert.equal(setting(card, "label").value, id);
    assert.equal(setting(card, "role").value, "RX");
    assert.equal(card.dataset.tokenEnv, `DISCORD_BOT_TOKEN_${id}`);
    assert.equal(setting(card, "token").value, token);
    assert.equal(setting(card, "guildId").value, "100000000000000001");
    assert.equal(setting(card, "voiceChannelId").value, "");
    assert.equal(card.querySelector('[data-field="token-state"]')!.textContent, "保存予定");
  }
  assert.equal(setting(existing, "voiceChannelId").value, "200000000000000001");
  assert.equal(elements.bulkBotTokens.value, "");
  assert.equal(context.settingsDirty, true);
  assert.match(elements.botProfileCount.textContent, /全3/);
  assert.deepEqual(notices, ["2件追加しました（上限で0件、重複・形式不正で1件をスキップ）"]);

  context.settingsSnapshot.limits.total = 4;
  const tokenC = "FAKE_DESKTOP_TOKEN_C_DO_NOT_DISPLAY", tokenD = "FAKE_DESKTOP_TOKEN_D_DO_NOT_DISPLAY";
  elements.bulkBotTokens.value = `${tokenC}\n${tokenD}\n${tokenD}\nbad token\nbad#token\nbad=token\n${"z".repeat(257)}\n`;
  elements.addBotTokens.click();
  assert.equal(cards.length, 4);
  assert.equal(setting(cards[3], "token").value, tokenC);
  assert.equal(setting(cards[3], "voiceChannelId").value, "");
  assert.equal(elements.bulkBotTokens.value, "");
  assert.equal(elements.addBotTokens.disabled, true);
  assert.equal(notices.length, 2, "one notice per batch");
  assert.equal(notices[1], "1件追加しました（上限で1件、重複・形式不正で5件をスキップ）");
  const visibleText = (element: Element): string => element.textContent + element.innerHTML + [...element.fields.values(), ...element.children].map(visibleText).join("");
  for (const token of [tokenA, tokenB, tokenC, tokenD]) {
    assert.equal(notices.join(" ").includes(token), false);
    assert.equal(visibleText(elements.botProfileList).includes(token), false);
  }
  context.settingsSnapshot.limits.total = 24;
  for (const state of ["ON_AIR", "FAULT"]) {
    context.snapshot.state = state;
    context.updateBotProfileCount();
    assert.equal(elements.addBotTokens.disabled, true);
    assert.equal(elements.bulkBotTokens.disabled, true);
    elements.bulkBotTokens.value = tokenD;
    context.addBotProfileTokens();
    assert.equal(cards.length, 4);
    assert.equal(notices.length, 2);
  }
  context.snapshot.state = "READY";
  context.updateBotProfileCount();
  assert.equal(elements.addBotTokens.disabled, false);
  assert.equal(elements.bulkBotTokens.disabled, false);
});
