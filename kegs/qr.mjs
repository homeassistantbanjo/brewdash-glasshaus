// GlassHaus keg QR — RUNTIME side (zero-dep). QR content is permanent per keg (the URL
// never changes), so the SVGs are generated ONCE at build/seed time by gen-qr.mjs (which
// uses the mature, verified `qrcode` lib) and written to ./qr-svg/<id>.svg. This module
// just reads the pre-generated file. Rationale: a hand-rolled encoder produced
// structurally-valid-but-UNSCANNABLE output (caught by decoding with jsQR); for permanently
// printed stickers, only a verified encoder is acceptable — and it has no business running
// at request time. See docs/keg-management-design.md ("QR — corrected approach").

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const QR_DIR = process.env.QR_DIR || join(HERE, 'qr-svg');

/** The permanent URL a keg's QR sticker encodes. */
export function kegUrl(baseUrl, id) {
  return `${String(baseUrl).replace(/\/$/, '')}/kegs/${encodeURIComponent(id)}`;
}

/** Read the pre-generated QR SVG for a keg id. Throws if it wasn't generated at build time. */
export async function kegQrSvg(id) {
  try {
    return await readFile(join(QR_DIR, `${id}.svg`), 'utf8');
  } catch {
    throw new Error(`no QR svg for ${id} — run gen-qr.mjs at build time`);
  }
}
