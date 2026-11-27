import assert from 'node:assert/strict';
import { request as httpsRequest, createServer as createTlsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { VcBus } from '../services/router-core-sim/src/audio-engine.ts';
import { LanControl } from '../services/router-core-sim/src/lan-control.ts';
import { LanControlStore, emptyLanScope, LAN_GROUPS, type LanGroup } from '../services/router-core-sim/src/lan-control-store.ts';
import { generateLanCertificate } from '../services/router-core-sim/src/lan-certificate.ts';
import { encodeConnectionCode, parseConnectionCode, pinnedLanRequest, type LanConnection } from '../services/router-core-sim/src/lan-client.ts';
import { createTokenProtection } from '../services/discord-adapter/src/token-protection.ts';
import { fixture, availablePort } from './helpers/external-control-fixture.ts';
import { clientFrame, connectWs } from './helpers/external-ws.ts';
import { RecorderManager } from '../services/router-core-sim/src/recorder.ts';
import { COMMAND_POLICIES } from '../services/router-core-sim/src/external-protocol.ts';

const code = (reply: any, expected: string, status: number) => { assert.equal(reply.status, status); assert.equal(reply.body.code, expected); };
async function setup(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t), port = await availablePort();
  const lan = new LanControl(f.root, f.api, () => [f.api.port], () => ['127.0.0.1', '127.0.0.2'], createTokenProtection('linux'));
  t.after(() => lan.close());
  const add = (name: string, output: number) => {
    const result = f.control.execute({ type: 'CREATE_OUTPUT_SELECTOR', name, output, outputMode: 'MONO', mode: 'SWITCH', sourceBusIds: [f.bus.id] });
    assert.equal(result.ok, true); return f.api.state.publicBusId((result.data as { selectorId: string }).selectorId);
  };
  const selectorId = add('Director', 0), otherId = add('Observer', 1);
  await lan.manage({ action: 'configure', enabled: true, address: '127.0.0.1', port });
  const scope = { ...emptyLanScope(), enabled: true, addresses: ['127.0.0.1'], selectorIds: [selectorId] };
  await lan.manage({ action: 'scope', deviceId: f.registration.deviceId, scope });
  const issued = await lan.manage({ action: 'connection-code', deviceId: f.registration.deviceId, reissue: true }) as { connectionCode: string };
  const connectionCode = issued.connectionCode, connection = parseConnectionCode(connectionCode);
  const read = (path = '/state', localAddress?: string) => { f.advance(); return pinnedLanRequest(connectionCode, 'GET', '/external/v1' + path, undefined, localAddress); };
  const request = (operation: string, args: unknown, path = '/actions', extra = {}) => ({ requestId: randomUUID(), instanceId: lan.api!.state.instanceId, operation, args, ...extra });
  const action = async (operation: string, args: unknown, path = '/actions') => { f.advance(); return pinnedLanRequest(connectionCode, 'POST', '/external/v1' + path, request(operation, args)); };
  const grant = async (groups: LanGroup[], selectorIds = [selectorId]) => lan.manage({ action: 'scope', deviceId: f.registration.deviceId, scope: { ...scope, groups, selectorIds } });
  return { ...f, lan, port, selectorId, otherId, scope, connectionCode, connection, read, action, request, grant };
}
function raw(connection: LanConnection, headers: Record<string, string> = {}, localAddress?: string, version: 'TLSv1.3' | 'TLSv1.2' = 'TLSv1.3') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpsRequest({ hostname: connection.address, port: connection.port, path: '/external/v1/state', method: 'GET', localAddress,
      rejectUnauthorized: false, minVersion: version, maxVersion: version, agent: false,
      headers: { Host: `${connection.address}:${connection.port}`, Authorization: `Bearer ${connection.token}`, ...headers } }, response => {
      let bytes = ''; response.on('data', chunk => bytes += chunk); response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(bytes) }); } catch { reject(new Error('Invalid test response')); } });
    }); request.on('error', () => reject(new Error('TLS test connection rejected'))); request.setTimeout(3000, () => request.destroy()); request.end();
  });
}

test('LAN uses TLS 1.3 only, binds one selected address, rejects HTTP/other addresses and wrong Host/forwarding', async t => {
  const f = await setup(t);
  assert.equal(f.api.store.enabled, false, 'LAN ON does not enable or alter the loopback API');
  assert.equal((f.lan.api!.server.address() as { address: string }).address, '127.0.0.1');
  assert.equal((await f.read()).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/external/v1/state`, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(fetch(`http://127.0.0.2:${f.port}/external/v1/state`, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(raw(f.connection, {}, undefined, 'TLSv1.2'));
  code(await raw(f.connection, { Host: `localhost:${f.port}` }), 'HOST_FORBIDDEN', 403);
  for (const header of ['Forwarded', 'X-Forwarded-For', 'Via', 'X-Real-IP']) code(await raw(f.connection, { [header]: '127.0.0.1' }), 'HOST_FORBIDDEN', 403);
});

test('pinned reference client rejects a different certificate before transmitting credentials', async t => {
  const f = await setup(t), material = await generateLanCertificate('127.0.0.1'); let requests = 0;
  const foreign = createTlsServer({ cert: material.certificate, key: material.key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (_req, res) => { requests++; res.end('{}'); });
  foreign.listen(await availablePort(), '127.0.0.1'); await once(foreign, 'listening'); t.after(() => { foreign.close(); foreign.closeAllConnections(); });
  const foreignCode = encodeConnectionCode({ ...f.connection, port: (foreign.address() as { port: number }).port });
  await assert.rejects(pinnedLanRequest(foreignCode, 'GET', '/external/v1/state'), /指紋/); assert.equal(requests, 0);
});

test('unknown token, disallowed IP, LAN-disabled device and revoked token have the same unauthenticated response', async t => {
  const f = await setup(t), invalid = { ...f.connection, token: 'a'.repeat(43) };
  const unknown = await raw(invalid), wrongIp = await raw(f.connection, {}, '127.0.0.2');
  await f.lan.manage({ action: 'scope', deviceId: f.registration.deviceId, scope: { ...f.scope, enabled: false } });
  const disabled = await raw(f.connection);
  await f.grant([]); f.api.manage({ action: 'revoke', deviceId: f.registration.deviceId });
  const revoked = await raw(f.connection);
  for (const result of [unknown, wrongIp, disabled, revoked]) { code(result, 'UNAUTHORIZED', 401); assert.deepEqual(result.body, unknown.body); }
  assert.equal(f.commands.length, 0);
});

test('selector-only LAN controller sees only its selector/sources, cannot select others, and keeps dedup/revision checks', async t => {
  const f = await setup(t), state = (await f.read()).body.data;
  assert.equal(state.selectors.length, 1); assert.equal(state.selectors[0].selectorId, f.selectorId); assert.equal(state.selectors[0].name, 'Director');
  assert.ok(state.buses.every((bus: any) => [f.selectorId, f.bus.id].includes(bus.busId)));
  assert.ok(state.buses.every((bus: any) => Object.keys(bus).every(key => key === 'busId' || key === 'label')));
  for (const field of ['participants', 'registeredUsers', 'participantOrders', 'participantsRevision', 'tx', 'pfl', 'scenes', 'recorder', 'outputCount']) assert.equal(Object.hasOwn(state, field), false);
  assert.equal(JSON.stringify(state).includes(f.channel.discordUserId!), false); assert.equal(JSON.stringify(state).includes(f.bus.label), false);
  code(await f.action('selector.off', { selectorId: f.otherId }), 'TIER_FORBIDDEN', 403);
  const body = f.request('selector.select', { selectorId: f.selectorId, busId: f.bus.id, operation: 'SWITCH' });
  const a = await pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/actions', body), b = await pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/actions', body);
  assert.equal(a.status, 200); assert.deepEqual(b.body, a.body); assert.equal(f.commands.length, 1);
  const stale = await pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/actions', { ...f.request('selector.off', { selectorId: f.selectorId }), instanceId: randomUUID() }); code(stale, 'STALE_REVISION', 409);
  for (const operation of ['CREATE_OUTPUT_SELECTOR', 'SET_BUS_OUTPUT', 'CONNECT_DISCORD_BOT', 'CLEAR_EVENT_LOG', 'settings.lock.set']) code(await f.action(operation, {}), 'TIER_FORBIDDEN', 403);
  assert.ok(f.logs.some(line => line.startsWith('LAN control action device=') && line.includes('ip=127.0.0.1') && line.includes('selector.select')));
  assert.ok(f.logs.every(line => !line.includes(f.connection.token) && !line.includes(f.connectionCode) && !line.includes(f.channel.label) && !line.includes(f.channel.discordUserId!)));
});

test('global external Stop immediately closes LAN and persists OFF, while the local entry still has its original state', async t => {
  const f = await setup(t); assert.equal((await f.read()).status, 200);
  f.api.manage({ action: 'stop' });
  assert.equal(f.lan.snapshot().enabled, false); assert.equal(f.lan.api, undefined); assert.equal(new LanControlStore(f.root).snapshot().enabled, false);
  await assert.rejects(f.read());
  f.api.manage({ action: 'enable' });
  const localReply = await fetch(f.base + '/state', { headers: { ...f.headers, authorization: `Bearer ${f.connection.token}` } });
  assert.equal(localReply.status, 200); const local = (await localReply.json() as any).data;
  assert.equal(local.selectors.length, 2); assert.ok(Array.isArray(local.participants));
});

test('key reissue invalidates old code, certificate rotation changes the pin, and all codes must be copied again', async t => {
  const f = await setup(t); f.api.manage({ action: 'reissue', deviceId: f.registration.deviceId }); await f.lan.secrets.flush();
  code(await f.read(), 'UNAUTHORIZED', 401);
  const next = await f.lan.manage({ action: 'connection-code', deviceId: f.registration.deviceId }) as { connectionCode: string };
  assert.equal((await pinnedLanRequest(next.connectionCode, 'GET', '/external/v1/state')).status, 200);
  const before = f.lan.secrets.fingerprint(); await f.lan.manage({ action: 'rotate', confirmed: true }); assert.ok(f.lan.secrets.fingerprint() !== before);
  await assert.rejects(pinnedLanRequest(next.connectionCode, 'GET', '/external/v1/state'), /指紋/);
  const rotated = await f.lan.manage({ action: 'connection-code', deviceId: f.registration.deviceId }) as { connectionCode: string };
  assert.equal((await pinnedLanRequest(rotated.connectionCode, 'GET', '/external/v1/state')).status, 200);
});

test('saved ON/address/port/scopes restore without enabling loopback API; occupied port and vanished address affect LAN only', async t => {
  const f = await setup(t); await f.lan.close();
  const restored = new LanControl(f.root, f.api, () => [f.api.port], () => ['127.0.0.1'], createTokenProtection('linux')); t.after(() => restored.close());
  await restored.start(); assert.equal(restored.snapshot().listening, true); assert.equal(f.api.store.enabled, false);
  assert.equal((await pinnedLanRequest(f.connectionCode, 'GET', '/external/v1/state')).status, 200); await restored.close();
  const blocker = createTcpServer(); blocker.listen(f.port, '127.0.0.1'); await once(blocker, 'listening'); t.after(() => blocker.close());
  const occupied = new LanControl(f.root, f.api, () => [f.api.port], () => ['127.0.0.1'], createTokenProtection('linux')); t.after(() => occupied.close());
  await occupied.start(); assert.equal(occupied.snapshot().listening, false); assert.match(occupied.snapshot().error!, /ポート/);
  const before = f.engine.blocksProcessed; f.engine.processBlock(); assert.ok(f.engine.blocksProcessed > before); assert.equal(f.control.state, 'SETUP');
  const vanished = new LanControl(f.root, f.api, () => [f.api.port], () => [], createTokenProtection('linux')); t.after(() => vanished.close());
  await vanished.start(); assert.equal(vanished.snapshot().listening, false); assert.match(vanished.snapshot().error!, /IPv4/);
});

test('address/port/IP-list/scope validation never broadens the bind or bypasses SETUP', async t => {
  const f = await setup(t);
  for (const address of ['0.0.0.0', '::1', '192.0.2.200']) await assert.rejects(f.lan.manage({ action: 'configure', enabled: true, address, port: f.port }));
  await assert.rejects(f.lan.manage({ action: 'configure', enabled: true, address: '127.0.0.1', port: f.api.port }));
  for (const addresses of [['127.0.0.1', '127.0.0.1'], ['::1'], Array.from({ length: 9 }, (_, i) => `192.0.2.${i + 1}`)]) await assert.rejects(f.lan.manage({ action: 'scope', deviceId: f.registration.deviceId, scope: { ...f.scope, addresses } }));
  f.control.state = 'ON_AIR'; await assert.rejects(f.lan.manage({ action: 'rotate', confirmed: true }));
  assert.equal((await f.action('selector.off', { selectorId: f.selectorId })).status, 200);
  assert.equal((f.lan.api!.server.address() as { address: string }).address, '127.0.0.1');
});

test('each additional operation group is opt-in; Tier B still needs its existing permission and arm/execute', async t => {
  const f = await setup(t);
  const operations: Array<[LanGroup, string, unknown]> = [
    ['mix', 'bus.mute.set', { busId: f.bus.id, mute: true }], ['cue', 'pfl.set', { source: { kind: 'bus', busId: f.bus.id } }],
    ['emergency', 'emergency.set', { active: true }], ['tx', 'tx.stop', { profileId: 'TX1' }],
    ['recording', 'recording.stop', {}], ['scenes', 'scene.recall', { sceneId: 'missing', previewId: 'missing' }],
  ];
  for (const [group, operation, args] of operations) {
    await f.grant([]); code(await f.action(operation, args), 'TIER_FORBIDDEN', 403);
    await f.grant([group]); const result = await f.action(operation, args);
    if (group === 'recording' || group === 'scenes') code(result, 'TIER_FORBIDDEN', 403); else assert.equal(result.status, 200);
  }
  await f.grant(['mix']); code(await f.action('bus.mute.set', { busId: f.otherId, mute: true }), 'TIER_FORBIDDEN', 403);
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ['bus.fader.set'] });
  f.bus.masterDb = -40;
  code(await f.action('bus.fader.set', { busId: f.bus.id, db: 0 }), 'CONFIRMATION_REQUIRED', 409);
  const arm = await f.action('bus.fader.set', { busId: f.bus.id, db: 0 }, '/arm'); assert.equal(arm.status, 200);
  f.advance(1000);
  const execute = await pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/execute', { requestId: randomUUID(), instanceId: f.lan.api!.state.instanceId, armId: arm.body.data.armId });
  assert.equal(execute.status, 200); assert.equal(f.bus.masterDb, 0);
  const state = (await f.read()).body.data; assert.ok(Array.isArray(state.participants));
  await f.grant([]); const reduced = (await f.read()).body.data; assert.equal(Object.hasOwn(reduced, 'participants'), false);
});

test('TLS WS uses the same reduced state, denies meter side channels and disconnects when scope changes', async t => {
  const f = await setup(t), ws = await connectWs(f.port, `Bearer ${f.connection.token}`, '', '/external/v1/ws', true); t.after(() => ws.socket.destroy());
  assert.equal(ws.status, 101); const first = await ws.next(); assert.equal(first.payload.selectors.length, 1); assert.equal(Object.hasOwn(first.payload, 'participants'), false);
  ws.socket.write(clientFrame(JSON.stringify({ type: 'meters.subscribe', requestId: randomUUID(), sources: [{ kind: 'bus', busId: f.otherId }], hz: 10 })));
  const denied = await ws.next(); assert.equal(denied.payload.code, 'TIER_FORBIDDEN');
  const closed = once(ws.socket, 'close'); await f.grant(['mix']); await closed;
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: true });
  const named = (await f.read()).body.data; assert.ok(named.buses.some((bus: any) => bus.label === f.bus.label));
  await f.grant([]); const hiddenParticipants = (await f.read()).body.data; assert.equal(Object.hasOwn(hiddenParticipants, 'participants'), false);
});

test('all Tier C operations stay forbidden even when every LAN group is enabled; unauthenticated floods are bounded', async t => {
  const f = await setup(t); await f.grant([...LAN_GROUPS], [f.selectorId, f.otherId]);
  for (const [operation, tier] of Object.entries(COMMAND_POLICIES)) if (tier === 'C') code(await f.action(operation, {}), 'TIER_FORBIDDEN', 403);
  const invalid = { ...f.connection, token: 'z'.repeat(43) };
  for (let i = 0; i < 20; i++) code(await raw(invalid, {}, '127.0.0.2'), 'UNAUTHORIZED', 401);
  code(await raw(invalid, {}, '127.0.0.2'), 'RATE_LIMITED', 429);
  assert.equal((await f.read()).status, 200); assert.equal(f.commands.length, 0);
});

test('scene-only previews hide participants, and LAN scene/recording groups retain Tier B confirmation end to end', async t => {
  const f = await setup(t); await f.grant(['scenes'], [f.selectorId, f.otherId]);
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ['scene.recall', 'recording.start', 'recording.stop'] });
  f.channel.faderDb = -20; const saved = f.control.execute({ type: 'SAVE_SCENE', name: 'Synthetic scene' }).data as { id: string };
  f.channel.faderDb = -10; f.bus.masterDb = -6;
  const preview = await f.action('scene.preview', { sceneId: saved.id }); assert.equal(preview.status, 200);
  assert.equal(JSON.stringify(preview.body).includes(f.channel.discordUserId!), false); assert.equal(JSON.stringify(preview.body).includes(f.channel.label), false);
  const sceneArgs = { sceneId: saved.id, previewId: preview.body.data.previewId };
  code(await f.action('scene.recall', sceneArgs), 'CONFIRMATION_REQUIRED', 409);
  const arm = await f.action('scene.recall', sceneArgs, '/arm'); assert.equal(arm.status, 200); assert.equal(JSON.stringify(arm.body).includes(f.channel.discordUserId!), false);
  const execute = async (armId: string) => { f.advance(1000); return pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/execute', { requestId: randomUUID(), instanceId: f.lan.api!.state.instanceId, armId }); };
  assert.equal((await execute(arm.body.data.armId)).status, 200); assert.equal(f.channel.faderDb, -20);
  const recorder = new RecorderManager(f.engine, join(f.root, 'recordings')); Object.defineProperty(f.control, 'recorder', { value: recorder, configurable: true }); t.after(() => recorder.close());
  await f.grant(['recording']); const recordingArgs = { selection: { outputs: [], busIds: [f.bus.id], participants: [] } };
  code(await f.action('recording.start', recordingArgs), 'CONFIRMATION_REQUIRED', 409);
  const start = await f.action('recording.start', recordingArgs, '/arm'); assert.equal(start.status, 200); assert.equal((await execute(start.body.data.armId)).status, 200);
  f.engine.processBlock(); recorder.captureBlock();
  const stop = await f.action('recording.stop', {}, '/arm'); assert.equal(stop.status, 200); assert.equal((await execute(stop.body.data.armId)).status, 200); await recorder.waitForIdle();
  assert.equal(recorder.state, 'IDLE');
});

test('changing LAN scope after arm consumes authority and cannot execute the previous confirmation', async t => {
  const f = await setup(t); await f.grant(['mix']); f.bus.masterDb = -40;
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: false, allowedTierBOperations: ['bus.fader.set'] });
  const arm = await f.action('bus.fader.set', { busId: f.bus.id, db: 0 }, '/arm'); assert.equal(arm.status, 200);
  await f.grant([]); f.advance(1000);
  const result = await pinnedLanRequest(f.connectionCode, 'POST', '/external/v1/execute', { requestId: randomUUID(), instanceId: f.lan.api!.state.instanceId, armId: arm.body.data.armId });
  assert.notEqual(result.status, 200); assert.equal(f.bus.masterDb, -40); assert.equal(f.commands.length, 0);
});

test('recording group alone does not disclose participants without recording.start permission, and scopes store public IDs', async t => {
  const f = await setup(t); await f.grant(['recording']);
  let state = (await f.read()).body.data; assert.equal(Object.hasOwn(state, 'participants'), false); assert.equal(Object.hasOwn(state, 'outputCount'), false);
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: true, allowedTierBOperations: ['recording.stop'] });
  state = (await f.read()).body.data; assert.equal(Object.hasOwn(state, 'participants'), false);
  f.api.manage({ action: 'permissions', deviceId: f.registration.deviceId, readDisplayNames: true, allowedTierBOperations: ['recording.start'] });
  state = (await f.read()).body.data; assert.ok(Array.isArray(state.participants));
  const internal = f.api.state.resolveBusId(f.selectorId);
  await f.lan.manage({ action: 'scope', deviceId: f.registration.deviceId, scope: { ...f.scope, selectorIds: [internal] } });
  assert.deepEqual(f.lan.store.scope(f.registration.deviceId).selectorIds, [f.selectorId]);
});

test('LAN authority is rechecked after a partially received request body', async t => {
  const f = await setup(t); await f.grant(['mix']); f.bus.mute = false;
  const payload = JSON.stringify(f.request('bus.mute.set', { busId: f.bus.id, mute: true })), cut = Math.floor(payload.length / 2);
  const arrived = once(f.lan.api!.server, 'request');
  let request!: ReturnType<typeof httpsRequest>;
  const reply = new Promise<{ status: number; body: any }>((resolve, reject) => {
    request = httpsRequest({ hostname: '127.0.0.1', port: f.port, path: '/external/v1/actions', method: 'POST', agent: false, rejectUnauthorized: false,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', headers: { Host: `127.0.0.1:${f.port}`, Authorization: `Bearer ${f.connection.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => {
      let text = ''; response.on('data', bytes => text += bytes); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on('error', () => reject(new Error('Pending LAN test request closed'))); request.flushHeaders(); request.write(payload.slice(0, cut));
  });
  await arrived; await f.grant([]); request.end(payload.slice(cut));
  code(await reply, 'TIER_FORBIDDEN', 403); assert.equal(f.bus.mute, false); assert.equal(f.commands.length, 0);
});
