import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = readFileSync(new URL("../services/router-core-sim/public/app.js", import.meta.url), "utf8");

function fixture() {
  const timers = new Map<number, { callback: () => unknown; ms: number }>();
  const sockets: Peer[] = [];
  const requests: Array<{ url: string; options: any }> = [];
  let nextTimer = 0, reloads = 0;
  class Peer {
    static OPEN = 1;
    readyState = 0;
    handlers = new Map<string, (event?: unknown) => void>();
    url: string;
    constructor(url: string) { this.url = url; sockets.push(this); }
    addEventListener(name: string, handler: (event?: unknown) => void) { this.handlers.set(name, handler); }
    fire(name: string) { this.readyState = name === "open" ? 1 : 3; this.handlers.get(name)?.(); }
  }
  const context: any = {
    socket: null, snapshot: null, restartRequested: false, shutdownRequested: false,
    sessionExpired: false, reconnectTimer: null, reconnectDelayMs: 1000,
    desktopSessionNonce: "old-nonce", desktopJsonHeaders: { "content-type": "application/json", "x-dbr-session-nonce": "old-nonce" },
    botRecoveries: new Map(), AbortSignal,
    elements: { controlState: { textContent: "", className: "" }, sessionExpired: { hidden: true } },
    location: { protocol: "http:", host: "127.0.0.1:4173", reload() { reloads++; } },
    WebSocket: Peer,
    setTimeout(callback: () => unknown, ms: number) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    probe: async () => { throw new Error("server is stopped"); },
  };
  context.fetch = async (url: string, options: any) => { requests.push({ url, options }); return context.probe(); };
  runInNewContext(script.slice(script.indexOf("function setConnection("), script.indexOf("\nfunction sendCommand(")), context);
  return {
    context, timers, sockets, requests, reloads: () => reloads,
    reply(status: number) { context.probe = async () => ({ status, ok: status === 200 }); },
    async retry() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0]; timers.delete(id);
      await timer.callback();
      return timer.ms;
    },
  };
}

test("unreachable desktop retries at 1/2/4/8/10 seconds and recovery resets the delay", async () => {
  const f = fixture();
  f.context.connect(); f.sockets[0].fire("open"); f.sockets[0].fire("close");
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await f.retry());
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(f.sockets.length, 1, "failed probes never attempt WS upgrades");
  assert.equal(f.reloads(), 0);
  f.reply(200); await f.retry();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.context.reconnectDelayMs, 1000);
  f.sockets[1].fire("open"); f.sockets[1].fire("close");
  assert.equal([...f.timers.values()][0].ms, 1000);
  assert.equal(f.requests[0].url, "/api/session/check");
  assert.equal(f.requests[0].options.method, "POST");
  assert.equal(f.requests[0].options.headers["x-dbr-session-nonce"], "old-nonce");
  assert.equal(f.requests[0].options.cache, "no-store");
  assert.ok(f.requests[0].options.signal);
});

test("403 marks an old tab expired, persists reload guidance and stops all reconnects", async () => {
  const f = fixture(); f.reply(403);
  f.context.connect(); f.sockets[0].fire("close"); await f.retry();
  assert.equal(f.context.sessionExpired, true);
  assert.equal(f.context.elements.sessionExpired.hidden, false);
  assert.equal(f.context.elements.controlState.textContent, "システム: 再読み込みが必要です");
  assert.equal(f.timers.size, 0); assert.equal(f.reloads(), 0);
  f.context.connect(); f.context.scheduleReconnect(); await f.context.reconnectDesktop();
  assert.equal(f.sockets.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  const html = readFileSync(new URL("../services/router-core-sim/public/index.html", import.meta.url), "utf8");
  assert.match(html, /role="alert" hidden>[\s\S]*ParaBus が再起動されました。ページを再読み込みしてください/);
  assert.match(script, /elements.reloadDesktop.addEventListener\("click", \(\) => location.reload\(\)\)/);
});

test("only a tab that requested restart reloads once the server answers, including a changed nonce", async () => {
  for (const status of [200, 403]) {
    const f = fixture();
    f.context.connect(); f.context.restartRequested = true; f.sockets[0].fire("close");
    await f.retry(); assert.equal(f.reloads(), 0, "no response while the server is down");
    f.reply(status); await f.retry();
    assert.equal(f.reloads(), 1); assert.equal(f.timers.size, 0);
    assert.equal(f.sockets.length, 1); assert.equal(f.context.sessionExpired, true);
    await f.context.reconnectDesktop(); assert.equal(f.reloads(), 1);
  }
});

test("temporary HTTP errors retry, while shutdown also wins over an in-flight probe", async () => {
  const f = fixture(); f.reply(503); f.context.connect(); f.sockets[0].fire("close");
  await f.retry(); assert.equal(f.context.sessionExpired, false); assert.equal(f.timers.size, 1);
  f.context.probe = async () => { f.context.shutdownRequested = true; return { status: 403, ok: false }; };
  await f.retry(); assert.equal(f.reloads(), 0); assert.equal(f.context.sessionExpired, false); assert.equal(f.timers.size, 0);
  const stopped = fixture(); stopped.context.connect(); stopped.context.shutdownRequested = true;
  stopped.sockets[0].fire("close");
  assert.equal(stopped.context.elements.controlState.textContent, "ParaBusを終了しました。このタブを閉じてください");
  assert.equal(stopped.timers.size, 0); assert.equal(stopped.requests.length, 0);
});
