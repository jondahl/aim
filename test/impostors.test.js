import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpostors } from '../lib/impostors.js';

test('impostors: an own-name gen older than mine counts at once; a newer one only after the grace, unless it is reported as mine', () => {
  let t = 1000;
  const im = createImpostors({ graceMs: 5000, now: () => t });
  im.mine('0m5k0000abcd');
  // Someone who was here before us (older start time): a joining session must refuse right away.
  assert.equal(im.announced('0m4z0000wxyz'), true);
  assert.equal(im.duplicate(), true);
  im.gone('0m4z0000wxyz');
  assert.equal(im.duplicate(), false);
  // Our own rotation: the next generation is announced before the publisher reports it.
  assert.equal(im.announced('0m5k0100efgh'), true);
  assert.equal(im.duplicate(), false);
  t += 3000;
  im.mine('0m5k0100efgh');
  t += 5000;
  assert.equal(im.duplicate(), false, 'reported as ours inside the grace');
  // A newer session that is not us: flagged once the grace has passed.
  im.announced('0m5k0200ijkl');
  t += 4999;
  assert.equal(im.duplicate(), false);
  t += 1;
  assert.equal(im.duplicate(), true);
  assert.equal(im.announced('0m5k0200ijkl'), false, 'already suspected');
});

test('impostors: reconcile drops suspects missing from the new connection; holder comes from their presence', () => {
  let t = 1000;
  const im = createImpostors({ graceMs: 5000, now: () => t });
  im.mine('b');
  im.announced('a');
  assert.equal(im.holder(), null, 'nothing heard yet');
  im.noteObject('a', { t: 'ack' });
  assert.deepEqual(im.holder(), { seenAt: 1000 });
  t = 2000;
  im.noteObject('a', { t: 'presence', meta: { harness: 'pi', workspace: 'w' }, lastActive: 1500 });
  assert.deepEqual(im.holder(), { harness: 'pi', workspace: 'w', lastActive: 1500, seenAt: 2000 });
  im.noteObject('zz', { t: 'presence', meta: { harness: 'x' } }); // not a suspect: ignored
  assert.equal(im.holder().harness, 'pi');
  im.reconcile(new Set(['b']));
  assert.equal(im.duplicate(), false);
  assert.equal(im.holder(), null);
  assert.deepEqual(im.suspects(), []);
});
