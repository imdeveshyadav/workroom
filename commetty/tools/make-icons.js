// Generates the PNG app icons for Commetty Book (no image libraries needed):
// an indigo rounded square with a white passbook card and a gold coin — same design as icons/icon.svg.
// Run: node commetty/tools/make-icons.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const INDIGO = [79, 70, 229], WHITE = [255, 255, 255], GOLD = [245, 180, 0], LINE = [199, 210, 254];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size * 512, (y + 0.5) / size * 512);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// scale < 1 shrinks the artwork toward the centre (maskable safe zone).
function icon(scale, rounded) {
  return (X, Y) => {
    if (rounded && !inRoundRect(X, Y, 0, 0, 512, 512, 112)) return [0, 0, 0, 0];
    const x = 256 + (X - 256) / scale, y = 256 + (Y - 256) / scale;
    let c = INDIGO;
    if (inRoundRect(x, y, 96, 112, 416, 400, 32)) {
      c = WHITE;
      if (inRoundRect(x, y, 136, 160, 376, 184, 12)) c = INDIGO;
      if (inRoundRect(x, y, 136, 220, 300, 240, 10) || inRoundRect(x, y, 136, 268, 260, 288, 10)) c = LINE;
    }
    const d = (x - 350) ** 2 + (y - 350) ** 2;
    if (d <= 86 ** 2) c = WHITE;
    if (d <= 72 ** 2) c = GOLD;
    if (d <= 48 ** 2 && d >= 36 ** 2) c = [255, 214, 92];
    return [...c, 255];
  };
}

const out = path.join(__dirname, '..', 'web', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, icon(1, true)));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, icon(1, true)));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, icon(0.78, false)));
console.log('Icons written to', out);
