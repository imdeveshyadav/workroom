'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workroom-test-'));
const { app } = require('../server.js');

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.closeAllConnections(); server.close(); });

const json = (url, body) => fetch(base + url, {
  method: body ? 'POST' : 'GET',
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function post(code, fields, image) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (image) fd.append('image', new Blob([image], { type: 'image/png' }), 'site.png');
  return fetch(`${base}/api/rooms/${code}/messages`, { method: 'POST', body: fd }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('group chat with photos, IDs, descriptions and export', async () => {
  const { body: room } = await json('/api/rooms', { name: 'Site A', userId: 'u1', userName: 'Asha' });
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  await json(`/api/rooms/${room.code}/join`, { userId: 'u2', userName: 'Bala' });
  const { body: info } = await json(`/api/rooms/${room.code}/join`, { userId: 'u3', userName: 'Chen' });
  assert.strictEqual(info.members.length, 3);

  // non-members are rejected
  assert.strictEqual((await post(room.code, { userId: 'x', text: 'hi' })).status, 403);

  const t = await post(room.code, { userId: 'u1', text: 'Morning team' });
  assert.strictEqual(t.body.uid, 'MSG-0001');

  // photo + caption share one ID; original stored byte-for-byte
  const p = await post(room.code, { userId: 'u2', text: 'Crack on wall' }, PNG);
  assert.strictEqual(p.status, 201);
  assert.strictEqual(p.body.uid, 'IMG-0001');
  assert.strictEqual(p.body.text, 'Crack on wall');
  const orig = Buffer.from(await (await fetch(base + p.body.image.url)).arrayBuffer());
  assert.ok(orig.equals(PNG));

  const p2 = await post(room.code, { userId: 'u3' }, PNG);
  assert.strictEqual(p2.body.uid, 'IMG-0002');

  // describe an earlier image
  const d = await post(room.code, { userId: 'u3', text: 'Needs plaster', refUid: 'IMG-0001' });
  assert.strictEqual(d.body.ref.uid, 'IMG-0001');
  assert.strictEqual((await post(room.code, { userId: 'u3', text: 'x', refUid: 'IMG-0099' })).status, 400);

  const { body: detail } = await json(`/api/rooms/${room.code}/images/IMG-0001?userId=u1`);
  assert.deepStrictEqual(detail.descriptions.map((x) => x.text), ['Needs plaster']);

  // everyone sees everything
  const { body: msgs } = await json(`/api/rooms/${room.code}/messages?userId=u3`);
  assert.deepStrictEqual(msgs.map((m) => m.uid), ['MSG-0001', 'IMG-0001', 'IMG-0002', 'MSG-0002']);

  // export
  const ex = await fetch(`${base}/api/rooms/${room.code}/export?minutes=2&userId=u1&tz=Asia/Kolkata&locale=en-IN`);
  assert.strictEqual(ex.status, 200);
  assert.match(ex.headers.get('content-disposition'), /attachment; filename="workroom-.*-2min-.*\.html"/);
  const html = await ex.text();
  for (const uid of ['MSG-0001', 'IMG-0001', 'IMG-0002', 'MSG-0002']) assert.ok(html.includes(`id="m-${uid}"`), uid);
  assert.ok(html.includes('IMG["IMG-0001"]="data:image/png;base64,' + PNG.toString('base64')));
  assert.ok(html.includes('Last 2 minutes'));

  assert.strictEqual((await fetch(`${base}/api/rooms/${room.code}/export?minutes=7&userId=u1`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/rooms/${room.code}/export?minutes=all&userId=u1`)).status, 200);
});

test('rejects non-image uploads', async () => {
  const { body: room } = await json('/api/rooms', { name: 'R', userId: 'a', userName: 'A' });
  const fd = new FormData();
  fd.append('userId', 'a');
  fd.append('image', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
  const r = await fetch(`${base}/api/rooms/${room.code}/messages`, { method: 'POST', body: fd });
  assert.strictEqual(r.status, 400);
});
