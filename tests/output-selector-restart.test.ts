import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ControlCommand, RouterSnapshot } from "../packages/shared-types/src/index.ts";

test("desktop commands persist output selectors across an actual isolated Mock Core restart", async t => {
  const root = mkdtempSync(join(tmpdir(), "parabus-selector-restart-"));
  const rack = join(root, "discord-bots.json"); writeFileSync(rack, '{"bots":[]}');
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill(); await exit;
    }
    rmSync(root, { recursive: true, force: true });
  });
  async function start() {
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DISCORD_|DBR_|NODE_|ROUTER_CORE_|RECORDER_|TABLET_)/i.test(name)));
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/server-without-rust.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...env, HOST: '127.0.0.1', PORT: String(port), DBR_OPERATOR_ORIGIN: base, DBR_SETTINGS_ROOT: root,
        DISCORD_IPC_ENDPOINT: process.platform === 'win32' ? String.raw`\\.\pipe\parabus-selector-${randomUUID()}` : join(root, 'discord.sock'), DISCORD_BOT_RACK_FILE: rack,
        DISCORD_BOT_RACK_JSON: '{"bots":[]}', RECORDER_FOLDER: join(root, 'recordings'), DBR_LAN_ACCESS: '0', ROUTER_CORE_OWNERSHIP: 'typescript' },
    });
    children.push(child);
    child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('isolated Mock Core startup timeout')), 20000);
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('isolated Mock Core exited before startup')); });
      child.stdout?.on('data', chunk => { if (String(chunk).includes('ParaBus Phase 10 listening on http://')) { clearTimeout(timeout); resolve(); } });
      child.once('error', reject);
    });
    const html = await (await fetch(base)).text();
    const nonce = html.match(/name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"/)![1];
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { origin: base, 'x-dbr-session-nonce': nonce, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return {
      state: async () => await (await fetch(base + '/api/state')).json() as RouterSnapshot,
      command: async (command: ControlCommand) => { const result = await (await post('/api/command', command)).json() as any; assert.equal(result.ok, true, result.error ?? command.type); return result.data; },
      stop: async () => { const exit = once(child, 'exit'); assert.equal((await post('/api/shutdown', { confirmed: true })).status, 202); await exit; },
      asset: () => fetch(base + '/output-selectors.js'),
    };
  }
  writeFileSync(join(root, 'output-selectors.json'), '{broken');
  const first = await start(), initial = await first.state(); assert.equal(initial.buses.length, 0);
  const warning = initial.alerts.find(event => event.message.includes('出力セレクターの設定を読み込めなかったため'));
  assert.ok(warning); assert.equal(warning.level, 'WARNING');
  const backup = readdirSync(root).find(name => name.startsWith('output-selectors.json.invalid-'))!;
  assert.ok(warning.message.includes(backup)); assert.equal(readFileSync(join(root, backup), 'utf8'), '{broken');
  const operational = readdirSync(join(root, 'logs')).find(name => name.startsWith('operational-'))!;
  await first.command({ type: 'SELECT_OUTPUT_DEVICE', deviceId: 'mock-64' });
  const a = await first.command({ type: 'CREATE_VC_BUS', name: 'Team A' }), b = await first.command({ type: 'CREATE_VC_BUS', name: 'Team B' });
  const { selectorId } = await first.command({ type: 'CREATE_OUTPUT_SELECTOR', name: 'Director', output: 2, outputMode: 'DUAL_MONO', mode: 'SWITCH', sourceBusIds: [a.busId, b.busId] });
  await first.command({ type: 'SELECT_OUTPUT_SELECTOR', selectorId, busId: a.busId, operation: 'SWITCH' });
  await first.command({ type: 'SET_BUS_MASTER', busId: selectorId, db: -6 });
  const scene = await first.command({ type: 'SAVE_SCENE', name: 'Recall' });
  await first.command({ type: 'SELECT_OUTPUT_SELECTOR', selectorId, busId: b.busId, operation: 'ADD' });
  await first.command({ type: 'RECALL_SCENE', sceneId: scene.id, confirmed: true });
  const before = (await first.state()).buses.find(bus => bus.id === selectorId)!;
  assert.deepEqual(before.selector?.selectedBusIds, [a.busId, b.busId]); assert.equal(before.selector?.fadeMs, 300);
  assert.equal((await first.asset()).status, 200);
  await first.stop();
  assert.ok(readFileSync(join(root, 'logs', operational), 'utf8').includes(warning.message), 'startup recovery warning reaches the operational log as well as desktop state');
  const second = await start();
  const after = (await second.state()).buses.find(bus => bus.id === selectorId)!;
  assert.deepEqual(after.selector, before.selector); assert.deepEqual(after.physicalOutputs, before.physicalOutputs); assert.equal(after.masterDb, -6);
  await second.stop();
});
