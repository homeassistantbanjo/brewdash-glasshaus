// BUILD-TIME QR generator (NOT shipped in the runtime image, NOT zero-dep — run at build).
// Generates a verified-scannable QR SVG per keg id into ./qr-svg/, using the mature `qrcode`
// library, and SELF-VERIFIES each one by rasterizing + decoding with `jsqr`. If any QR fails
// to decode back to its exact URL, the build ABORTS — we never ship an unscannable sticker.
//
// Usage:  BASE_URL=https://unraid.tail229434.ts.net node gen-qr.mjs keg-001 keg-002 ...
//   or:   BASE_URL=... COUNT=10 node gen-qr.mjs      (generates keg-001..keg-010)
//
// Deps (build only): qrcode, jsqr. Install transiently in the Docker build stage; the final
// runtime image contains only the generated SVGs + zero-dep server.

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'https://unraid.tail229434.ts.net').replace(/\/$/, '');
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.QR_DIR || join(HERE, 'qr-svg');

const kegUrl = (id) => `${BASE_URL}/kegs/${encodeURIComponent(id)}`;

// rasterize a qrcode matrix to RGBA + decode with jsQR → returns decoded string or null
function verify(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, data = qr.modules.data, quiet = 4, scale = 6, W = (n + quiet * 2) * scale;
  const rgba = Buffer.alloc(W * W * 4, 255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (data[r * n + c]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const x = (c + quiet) * scale + dx, y = (r + quiet) * scale + dy, o = (y * W + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
    }
  }
  const res = jsQR(new Uint8ClampedArray(rgba), W, W);
  return res ? res.data : null;
}

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Array.from({ length: Number(process.env.COUNT || 10) }, (_, i) => `keg-${String(i + 1).padStart(3, '0')}`);

await mkdir(OUT, { recursive: true });
let failed = 0;
for (const id of ids) {
  const url = kegUrl(id);
  const decoded = verify(url);
  if (decoded !== url) { console.error(`✗ ${id}: QR decode mismatch (got ${decoded})`); failed++; continue; }
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 300, color: { dark: '#0b0d0f', light: '#ffffff' } });
  await writeFile(join(OUT, `${id}.svg`), svg);
  console.log(`✓ ${id} → ${url} (verified scannable)`);
}
if (failed) { console.error(`\n${failed} QR(s) failed verification — ABORTING (won't ship unscannable stickers)`); process.exit(1); }
console.log(`\n${ids.length} QR svg(s) written to ${OUT}, all verified.`);
