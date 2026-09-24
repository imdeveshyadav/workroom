'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const multer = require('multer');
const WR = require('./public/render.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'workroom.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    img_seq    INTEGER NOT NULL DEFAULT 0,
    msg_seq    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS members (
    room_code TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_code, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code   TEXT NOT NULL,
    uid         TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    user_name   TEXT NOT NULL,
    text        TEXT,
    image_file  TEXT,
    image_mime  TEXT,
    image_size  INTEGER,
    image_name  TEXT,
    preview_file TEXT,
    ref_uid     TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (room_code, uid)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages (room_code, created_at);
`);

const q = {
  roomGet: db.prepare('SELECT * FROM rooms WHERE code = ?'),
  roomInsert: db.prepare('INSERT INTO rooms (code, name, created_by, created_at) VALUES (?, ?, ?, ?)'),
  nextImg: db.prepare('UPDATE rooms SET img_seq = img_seq + 1 WHERE code = ? RETURNING img_seq AS n'),
  nextMsg: db.prepare('UPDATE rooms SET msg_seq = msg_seq + 1 WHERE code = ? RETURNING msg_seq AS n'),
  memberUpsert: db.prepare(`INSERT INTO members (room_code, user_id, name, joined_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (room_code, user_id) DO UPDATE SET name = excluded.name`),
  memberGet: db.prepare('SELECT * FROM members WHERE room_code = ? AND user_id = ?'),
  members: db.prepare('SELECT user_id, name, joined_at FROM members WHERE room_code = ? ORDER BY joined_at'),
  msgInsert: db.prepare(`INSERT INTO messages
    (room_code, uid, user_id, user_name, text, image_file, image_mime, image_size, image_name, preview_file, ref_uid, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
  msgByUid: db.prepare('SELECT * FROM messages WHERE room_code = ? AND uid = ?'),
  msgsAfter: db.prepare('SELECT * FROM messages WHERE room_code = ? AND id > ? ORDER BY id LIMIT ?'),
  msgsLatest: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_code = ? ORDER BY id DESC LIMIT ?) ORDER BY id'),
  msgsBefore: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_code = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id'),
  msgsSince: db.prepare('SELECT * FROM messages WHERE room_code = ? AND created_at >= ? ORDER BY id'),
  msgsAll: db.prepare('SELECT * FROM messages WHERE room_code = ? ORDER BY id'),
  images: db.prepare('SELECT * FROM messages WHERE room_code = ? AND image_file IS NOT NULL ORDER BY id DESC'),
  descriptions: db.prepare('SELECT * FROM messages WHERE room_code = ? AND ref_uid = ? ORDER BY id'),
};

function toClient(row, withRef = true) {
  const m = {
    id: row.id,
    uid: row.uid,
    userId: row.user_id,
    userName: row.user_name,
    text: row.text || '',
    image: row.image_file
      ? {
        url: '/uploads/' + row.image_file,
        previewUrl: '/uploads/' + (row.preview_file || row.image_file),
        size: row.image_size, name: row.image_name, mime: row.image_mime,
      }
      : null,
    ref: null,
    createdAt: row.created_at,
  };
  if (withRef && row.ref_uid) {
    const r = q.msgByUid.get(row.room_code, row.ref_uid);
    if (r) m.ref = { uid: r.uid, userName: r.user_name, text: r.text || '', image: r.image_file ? { url: '/uploads/' + r.image_file, previewUrl: '/uploads/' + (r.preview_file || r.image_file) } : null };
  }
  return m;
}

function roomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    createdAt: room.created_at,
    members: q.members.all(room.code).map((r) => ({ userId: r.user_id, name: r.name, joinedAt: r.joined_at })),
  };
}

// ---------------------------------------------------------------- helpers
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!q.roomGet.get(code)) return code;
  }
}

function cleanName(s, max = 40) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireRoom(req) {
  const room = q.roomGet.get(String(req.params.code || '').toUpperCase());
  if (!room) throw httpError(404, 'Workroom not found');
  return room;
}

function requireMember(room, userId) {
  const m = userId && q.memberGet.get(room.code, String(userId));
  if (!m) throw httpError(403, 'Join this workroom first');
  return m;
}

// ---------------------------------------------------------------- realtime (SSE)
const streams = new Map(); // roomCode -> Set<res>

function broadcast(roomCode, event, data) {
  const set = streams.get(roomCode);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

// ---------------------------------------------------------------- uploads
const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/tiff': '.tif',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = EXT_BY_MIME[file.mimetype] || path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.img';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => cb(file.mimetype.startsWith('image/') ? null : httpError(400, 'Only image files can be uploaded'), true),
});

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.post('/api/rooms', (req, res) => {
  const name = cleanName(req.body.name, 60);
  const userId = String(req.body.userId || '');
  const userName = cleanName(req.body.userName);
  if (!name || !userId || !userName) throw httpError(400, 'Room name and your name are required');
  const code = newRoomCode();
  const now = Date.now();
  q.roomInsert.run(code, name, userId, now);
  q.memberUpsert.run(code, userId, userName, now);
  res.status(201).json(roomInfo(q.roomGet.get(code)));
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = requireRoom(req);
  const userId = String(req.body.userId || '');
  const userName = cleanName(req.body.userName);
  if (!userId || !userName) throw httpError(400, 'Your name is required');
  const existing = q.memberGet.get(room.code, userId);
  q.memberUpsert.run(room.code, userId, userName, Date.now());
  const info = roomInfo(room);
  if (!existing || existing.name !== userName) broadcast(room.code, 'members', info.members);
  res.json(info);
});

app.get('/api/rooms/:code', (req, res) => {
  res.json(roomInfo(requireRoom(req)));
});

app.get('/api/rooms/:code/messages', (req, res) => {
  const room = requireRoom(req);
  requireMember(room, req.query.userId);
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  let rows;
  if (req.query.after != null) rows = q.msgsAfter.all(room.code, Number(req.query.after) || 0, limit);
  else if (req.query.before != null) rows = q.msgsBefore.all(room.code, Number(req.query.before) || 0, limit);
  else rows = q.msgsLatest.all(room.code, limit);
  res.json(rows.map((r) => toClient(r)));
});

app.get('/api/rooms/:code/images', (req, res) => {
  const room = requireRoom(req);
  requireMember(room, req.query.userId);
  res.json(q.images.all(room.code).map((r) => toClient(r, false)));
});

app.get('/api/rooms/:code/images/:uid', (req, res) => {
  const room = requireRoom(req);
  requireMember(room, req.query.userId);
  const row = q.msgByUid.get(room.code, String(req.params.uid).toUpperCase());
  if (!row || !row.image_file) throw httpError(404, 'Image not found');
  res.json({ message: toClient(row), descriptions: q.descriptions.all(room.code, row.uid).map((r) => toClient(r, false)) });
});

const messageUpload = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'preview', maxCount: 1 }]);

app.post('/api/rooms/:code/messages', messageUpload, (req, res) => {
  // `image` is the untouched original; `preview` is an optional downscaled copy made by the phone for fast chat display.
  const file = req.files && req.files.image && req.files.image[0];
  const preview = file && req.files.preview && req.files.preview[0];
  const dropUploads = () => { for (const f of Object.values(req.files || {}).flat()) fs.rm(f.path, { force: true }, () => {}); };
  try {
    const room = requireRoom(req);
    const member = requireMember(room, req.body.userId);
    const text = String(req.body.text || '').trim().slice(0, 5000);
    let refUid = null;
    if (req.body.refUid && !file) {
      const ref = q.msgByUid.get(room.code, String(req.body.refUid).toUpperCase());
      if (!ref || !ref.image_file) throw httpError(400, 'The image you are describing no longer exists');
      refUid = ref.uid;
    }
    if (!text && !file) throw httpError(400, 'Type a message or attach a photo');
    if (req.files && req.files.preview && !file) throw httpError(400, 'Preview sent without a photo');

    // One ID per message: a photo + its caption share the same IMG-xxxx ID.
    const uid = file
      ? 'IMG-' + String(q.nextImg.get(room.code).n).padStart(4, '0')
      : 'MSG-' + String(q.nextMsg.get(room.code).n).padStart(4, '0');

    const row = q.msgInsert.get(
      room.code, uid, member.user_id, member.name, text || null,
      file ? file.filename : null, file ? file.mimetype : null, file ? file.size : null,
      file ? cleanName(file.originalname, 120) : null, preview ? preview.filename : null, refUid, Date.now(),
    );
    const msg = toClient(row);
    broadcast(room.code, 'message', msg);
    res.status(201).json(msg);
  } catch (err) {
    dropUploads();
    throw err;
  }
});

app.get('/api/rooms/:code/stream', (req, res) => {
  const room = requireRoom(req);
  requireMember(room, req.query.userId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (!streams.has(room.code)) streams.set(room.code, new Set());
  streams.get(room.code).add(res);
  req.on('close', () => {
    const set = streams.get(room.code);
    set.delete(res);
    if (!set.size) streams.delete(room.code);
  });
});

// ---------------------------------------------------------------- export
const EXPORT_RANGES = { 2: '2 minutes', 5: '5 minutes', 10: '10 minutes', 20: '20 minutes', 30: '30 minutes', 60: '1 hour', 360: '6 hours', 720: '12 hours' };
let cssCache = null;

app.get('/api/rooms/:code/export', async (req, res) => {
  const room = requireRoom(req);
  const member = requireMember(room, req.query.userId);
  const minutes = req.query.minutes === 'all' ? null : Number(req.query.minutes);
  if (minutes !== null && !EXPORT_RANGES[minutes]) throw httpError(400, 'Unknown export range');

  const now = Date.now();
  const rows = minutes === null ? q.msgsAll.all(room.code) : q.msgsSince.all(room.code, now - minutes * 60000);
  const msgs = rows.map((r) => toClient(r));
  const opts = {
    meId: member.user_id,
    tz: String(req.query.tz || '') || undefined,
    locale: String(req.query.locale || '') || undefined,
    // Images are embedded once (as data URIs) at the end of the file and wired up by a tiny script.
    imgAttr: (uid) => 'data-img="' + WR.esc(uid) + '" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="',
  };
  // Validate tz / locale so a bad value can't break rendering.
  try { WR.fmtTime(now, opts); } catch { opts.tz = undefined; opts.locale = undefined; }

  const images = new Map(); // uid -> {file, mime}
  for (const r of rows) {
    if (r.image_file) images.set(r.uid, { file: r.image_file, mime: r.image_mime });
    if (r.ref_uid && !images.has(r.ref_uid)) {
      const ref = q.msgByUid.get(room.code, r.ref_uid);
      if (ref && ref.image_file) images.set(ref.uid, { file: ref.image_file, mime: ref.image_mime });
    }
  }

  if (!cssCache || process.env.NODE_ENV !== 'production') cssCache = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
  const rangeLabel = minutes === null ? 'Entire chat' : 'Last ' + EXPORT_RANGES[minutes];
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const fileName = `workroom-${room.code}-${minutes === null ? 'all' : minutes + 'min'}-${stamp}.html`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');

  const esc = WR.esc;
  res.write(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(room.name)} – chat export (${esc(rangeLabel)})</title>
<style>${cssCache}</style></head>
<body class="export-page">
<div class="app">
<header class="topbar export-head">
  <div class="room-title"><div class="room-name">${esc(room.name)}</div>
  <div class="room-sub">Workroom ${esc(room.code)} · ${esc(rangeLabel)} · ${msgs.length} message${msgs.length === 1 ? '' : 's'}</div></div>
</header>
<div class="export-meta">Exported by ${esc(member.name)} on ${esc(WR.fmtDateTime(now, opts))}${minutes === null ? '' : ` · from ${esc(WR.fmtDateTime(now - minutes * 60000, opts))}`}</div>
<main class="chat" id="chat">
${msgs.length ? WR.renderMessages(msgs, opts) : '<div class="empty">No messages in this time range.</div>'}
</main>
</div>
<div class="lightbox" id="lb" hidden><img id="lb-img" alt=""><button class="lb-close" onclick="document.getElementById('lb').hidden=true" aria-label="Close">✕</button><div class="lb-cap" id="lb-cap"></div></div>
<script>var IMG={};</script>
`);

  for (const [uid, img] of images) {
    try {
      const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, img.file));
      res.write(`<script>IMG[${JSON.stringify(uid)}]="data:${img.mime};base64,${buf.toString('base64')}";</script>\n`);
    } catch { /* missing file: leave placeholder */ }
  }

  res.write(`<script>
(function(){
  document.querySelectorAll('img[data-img]').forEach(function(el){ var s = IMG[el.getAttribute('data-img')]; if (s) el.src = s; });
  document.querySelectorAll('a.photo').forEach(function(a){ var s = IMG[a.getAttribute('data-photo')]; if (s) a.href = s; a.removeAttribute('target'); });
  document.addEventListener('click', function(e){
    var a = e.target.closest('a.photo'); if (!a) return; e.preventDefault();
    var uid = a.getAttribute('data-photo'); document.getElementById('lb-img').src = IMG[uid] || '';
    document.getElementById('lb-cap').textContent = uid; document.getElementById('lb').hidden = false;
  });
})();
</script>
</body></html>`);
  res.end();
});

// ---------------------------------------------------------------- static
app.use('/uploads', express.static(UPLOAD_DIR, { immutable: true, maxAge: '365d', fallthrough: false }));
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get(['/r/:code', '/'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  let status = err.status || 500;
  let message = err.message || 'Something went wrong';
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = `Photo is larger than ${MAX_UPLOAD_MB} MB`;
  }
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Workroom running on http://localhost:${PORT}`));
}

module.exports = { app, db };
