import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { decodeInvite, encodeInvite, mintToken, validName } from '../lib/core.js';

const cfg = { ns: 'acme', room: 'r1', name: 'pi', kid: 'acme_aim-r1--pi', k: Buffer.from('secret-key-bytes').toString('base64url') };

test('invites round-trip, inside surrounding text too', () => {
  const inv = encodeInvite(cfg);
  assert.match(inv, /^aim1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeInvite(`  aim join ${inv}\n`), cfg);
  assert.throws(() => decodeInvite('hello'), /not an aim invite/);
});

test('tokens are HS256, rooted at the room, publishing only as the member', () => {
  const jwt = mintToken(cfg, 60);
  const [h, c, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: cfg.kid });
  assert.equal(claims.root, 'acme/aim/r1');
  assert.deepEqual(claims.put, ['u/pi']);
  assert.deepEqual(claims.get, ['']);
  assert.equal(claims.exp - claims.iat, 60);
  const expect = createHmac('sha256', Buffer.from(cfg.k, 'base64url')).update(`${h}.${c}`).digest('base64url');
  assert.equal(sig, expect);
});

test('names', () => {
  for (const ok of ['pi', 'claude-cloud', 'a1']) assert.ok(validName(ok), ok);
  for (const bad of ['', 'Pi', 'a--b', 'a-', '-a', 'a_b', 'x'.repeat(33)]) assert.ok(!validName(bad), bad);
});
