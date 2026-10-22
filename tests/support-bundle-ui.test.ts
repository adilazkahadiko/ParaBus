import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

class Element {
  disabled = false;
  value = "7";
  textContent = "";
  listeners: Record<string, () => Promise<void>> = {};
  addEventListener(event: string, callback: () => Promise<void>) { this.listeners[event] = callback; }
}

test("canonical desktop diagnostics offer authenticated support ZIP creation and open-output actions", async () => {
  for (const [page, script] of [["index.html", "app.js"]]) {
    const html = readFileSync(new URL(`../services/router-core-sim/public/${page}`, import.meta.url), "utf8");
    assert.match(html, /id="support-bundle"/);
    assert.match(html, /data-support-days type="number" min="1" max="30" value="7"/);
    assert.match(html, /data-support-status role="status"/);
    assert.match(html, /実行フォルダではなく/);
    assert.match(readFileSync(new URL(`../services/router-core-sim/public/${script}`, import.meta.url), "utf8"), /mountSupportBundle\(document.querySelector\("#support-bundle"\), fetch, localSettingsAvailable\)/);
  }
  const script = readFileSync(new URL("../services/router-core-sim/public/support-bundle.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const fields = Object.fromEntries(["create", "open", "days", "status"].map((key) => [key, new Element()]));
  const root = { querySelector: (selector: string) => fields[selector.match(/data-support-(\w+)/)![1]] };
  const context: any = { document: { querySelector: () => ({ content: "desktop-test-nonce" }) } };
  runInNewContext(script, context);
  const calls: Array<{ path: string; options: any }> = [];
  let complete: ((value: unknown) => void) | undefined;
  let fail = false;
  const request = async (path: string, options: any) => {
    calls.push({ path, options });
    if (path === "/api/support-bundle" && !fail) await new Promise((resolve) => { complete = resolve; });
    return { ok: !fail, json: async () => fail ? { ok: false, error: "export failed" } : { ok: true, path: "/test/support/bundle.zip" } };
  };
  context.mountSupportBundle(root, request);
  const pending = fields.create.listeners.click();
  assert.equal(fields.create.disabled, true);
  assert.equal(fields.days.disabled, true);
  assert.match(fields.status.textContent, /音声処理は継続/);
  assert.equal(calls[0].options.headers["x-dbr-session-nonce"], "desktop-test-nonce");
  assert.deepEqual(JSON.parse(calls[0].options.body), { days: 7 });
  complete!(null); await pending;
  assert.equal(fields.create.disabled, false);
  assert.equal(fields.days.disabled, false);
  assert.match(fields.status.textContent, /bundle\.zip.*このZIPのみ/);
  await fields.open.listeners.click();
  assert.equal(calls.at(-1)!.path, "/api/support-bundle/open-directory");
  assert.equal(fields.open.disabled, false);
  fail = true;
  await fields.create.listeners.click();
  assert.equal(fields.status.textContent, "export failed");
  assert.equal(fields.create.disabled, false);
  await fields.open.listeners.click();
  assert.match(fields.status.textContent, /settingsRoot\/support/);
  assert.equal(calls.some((call) => /command|settings$|restart|TX/.test(call.path)), false);
});

test("remote desktop Support Bundle controls are disabled without making a private API request", () => {
  const script = readFileSync(new URL("../services/router-core-sim/public/support-bundle.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const fields = Object.fromEntries(["create", "open", "days", "status"].map(key => [key, new Element()]));
  const root = { querySelector: (selector: string) => fields[selector.match(/data-support-(\w+)/)![1]] };
  const context: any = { document: { querySelector: () => ({ content: "test-nonce" }) } };
  runInNewContext(script, context);
  let requests = 0;
  context.mountSupportBundle(root, () => { requests++; }, false);
  for (const key of ["create", "open", "days"]) assert.equal(fields[key].disabled, true);
  assert.equal(fields.status.textContent, "このPCからのみ操作できます");
  assert.equal(fields.create.listeners.click, undefined);
  assert.equal(fields.open.listeners.click, undefined);
  assert.equal(requests, 0);
});
