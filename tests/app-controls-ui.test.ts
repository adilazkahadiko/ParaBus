import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("local app shutdown button confirms, respects live/recording locks and sends the authenticated shutdown request", async () => {
  const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");
  let click: () => Promise<void> = async () => {};
  const requests: Array<{ url: string; options: any }> = [];
  const context: any = {
    snapshot: { state: "SETUP", recorder: { state: "IDLE" } }, localSettingsAvailable: true,
    shutdownRequested: false, restartRequested: false, reconnectTimer: 0,
    elements: { restartRouter: { disabled: false }, restartDetail: { textContent: "" }, shutdownRouter: { disabled: false, addEventListener: (_type: string, handler: () => Promise<void>) => click = handler } },
    desktopJsonHeaders: { "x-dbr-session-nonce": "test-nonce" },
    confirm: () => false, clearTimeout() {}, showNotice() {},
    fetch: async (url: string, options: any) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; },
  };
  const render = script.indexOf("function renderRestart(");
  const handler = script.indexOf('elements.shutdownRouter.addEventListener("click"');
  runInNewContext(script.slice(render, script.indexOf("\n}", render) + 2) + "\n" + script.slice(handler, script.indexOf("\n});", handler) + 4), context);
  const repaint = () => context.renderRestart(context.snapshot);
  for (const state of ["ON_AIR", "FAULT"]) { context.snapshot.state = state; repaint(); assert.equal(context.elements.shutdownRouter.disabled, true); await click(); }
  context.snapshot.state = "SETUP";
  for (const state of ["RECORDING", "STOPPING"]) { context.snapshot.recorder.state = state; repaint(); assert.equal(context.elements.shutdownRouter.disabled, true); await click(); }
  context.snapshot.recorder.state = "IDLE"; context.localSettingsAvailable = false;
  repaint(); assert.equal(context.elements.shutdownRouter.disabled, true); await click();
  assert.match(context.elements.restartDetail.textContent, /このPCからのみ/);
  context.localSettingsAvailable = true; repaint(); await click();
  assert.equal(requests.length, 0, "cancel/locked/remote buttons never send requests");
  context.confirm = () => true;
  await click();
  assert.equal(requests.length, 1); assert.equal(requests[0].url, "/api/shutdown");
  assert.equal(requests[0].options.headers["x-dbr-session-nonce"], "test-nonce");
  assert.deepEqual(JSON.parse(requests[0].options.body), { confirmed: true });
  assert.equal(context.shutdownRequested, true); assert.equal(context.elements.restartRouter.disabled, true);
  assert.match(script, /if \(shutdownRequested\) return;[\s\S]*new WebSocket/, "closed app is not automatically reconnected");
});
