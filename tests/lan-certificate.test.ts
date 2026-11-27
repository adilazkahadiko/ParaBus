import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateLanCertificate } from '../services/router-core-sim/src/lan-certificate.ts';
import { encodeConnectionCode, parseConnectionCode } from '../services/router-core-sim/src/lan-client.ts';
import { LanSecretStore } from '../services/router-core-sim/src/lan-control-store.ts';
import { tokenProtection, PROTECTED_TOKEN_PREFIX } from '../services/discord-adapter/src/token-protection.ts';
import { sanitizeOperatorMessage } from '../services/router-core-sim/src/operator-sanitize.ts';

const fixture = (t: test.TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'parabus-lan-cert-'));
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'parabus-lan-cert-'))); rmSync(root, { recursive: true, force: true }); });
  return root;
};
test('dependency-free certificate is a valid self-signed P-256 X509 server certificate with matching private key', async () => {
  const result = await generateLanCertificate('127.0.0.1'), certificate = new X509Certificate(result.certificate);
  assert.equal(certificate.publicKey.asymmetricKeyType, 'ec'); assert.equal(certificate.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.equal(certificate.verify(certificate.publicKey), true); assert.equal(certificate.checkPrivateKey(createPrivateKey(result.key)), true);
  assert.equal(certificate.ca, false); assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1'); assert.ok(certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert.ok(certificate.fingerprint256.replaceAll(':', '').toLowerCase() === result.fingerprint);
  assert.ok(Date.parse(certificate.validFrom) < Date.now()); assert.ok(Date.parse(certificate.validTo) > Date.now());
  await assert.rejects(generateLanCertificate('0.0.0.0')); await assert.rejects(generateLanCertificate('::1'));
  const future = new X509Certificate((await generateLanCertificate('127.0.0.1', new Date('2051-01-01T00:00:00Z'))).certificate);
  assert.ok(Date.parse(future.validFrom) < Date.parse('2051-01-01T00:00:00Z')); assert.ok(Date.parse(future.validTo) > Date.parse('2051-01-01T00:00:00Z'));
});

test('connection code is versioned strict base64url JSON and errors never echo secret values', async () => {
  const result = await generateLanCertificate('127.0.0.1'), token = randomBytes(32).toString('base64url');
  const value = { v: 1 as const, address: '127.0.0.1', port: 4176, token, fingerprint: result.fingerprint }, code = encodeConnectionCode(value);
  assert.ok(code.startsWith('parabus1:')); assert.ok(parseConnectionCode(code).token === token); assert.ok(parseConnectionCode(code).fingerprint === result.fingerprint);
  for (const invalid of ['parabus2:abc', code + '=', 'parabus1:', 'parabus1:' + Buffer.from(JSON.stringify({ ...value, extra: true })).toString('base64url'), 'parabus1:' + Buffer.from(JSON.stringify({ ...value, address: '0.0.0.0' })).toString('base64url')]) {
    assert.throws(() => parseConnectionCode(invalid), error => error instanceof Error && !error.message.includes(token) && !error.message.includes(code));
  }
  assert.ok(!sanitizeOperatorMessage(`Code ${code}`).includes(code)); assert.ok(!sanitizeOperatorMessage(result.key).includes('BEGIN PRIVATE KEY'));
});

test('LAN private key and device tokens reuse actual CurrentUser DPAPI on Windows and survive reload', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t), warnings: string[] = [], store = new LanSecretStore(root, message => warnings.push(message));
  const material = await store.credentials('127.0.0.1'), id = '11111111-1111-4111-8111-111111111111', token = randomBytes(32).toString('base64url');
  await store.remember(id, token); await store.flush();
  const text = readFileSync(store.path, 'utf8'), saved = JSON.parse(text);
  assert.ok(saved.key.startsWith(PROTECTED_TOKEN_PREFIX)); assert.ok(saved.tokens[id].startsWith(PROTECTED_TOKEN_PREFIX));
  assert.ok(!text.includes(material.key)); assert.ok(!text.includes(token)); assert.equal(warnings.length, 0);
  const decoded = (await tokenProtection.unprotect([saved.key]))[0]; assert.ok(decoded === material.key);
  const next = new LanSecretStore(root, message => warnings.push(message)); assert.ok((await next.credentials('127.0.0.1')).key === material.key); assert.ok(await next.token(id) === token);
});

test('unavailable DPAPI falls back to private-file protection with a fixed warning, and unreadable vault never crashes status', async t => {
  const root = fixture(t), warnings: string[] = [], protection = { protect: async (values: readonly string[]) => values.map(() => null), unprotect: async (values: readonly string[]) => [...values] };
  const store = new LanSecretStore(root, message => warnings.push(message), protection), material = await store.credentials('127.0.0.1');
  assert.ok(warnings.length === 1); assert.ok(!warnings.join().includes(material.key)); assert.ok(store.protectionWarning);
  writeFileSync(store.path, '{"version":1,"certificate":"invalid","key":"invalid","tokens":{}}');
  const invalid = new LanSecretStore(root, message => warnings.push(message), protection); assert.equal(invalid.fingerprint(), null); assert.ok(invalid.error);
  await assert.rejects(invalid.credentials('127.0.0.1'));
  assert.ok((await invalid.credentials('127.0.0.1', true)).key.startsWith('-----BEGIN PRIVATE KEY-----'));
});
