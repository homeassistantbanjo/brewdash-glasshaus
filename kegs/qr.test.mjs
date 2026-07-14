import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('kegUrl builds the tailnet sticker URL', async () => {
  const { kegUrl } = await import('./qr.mjs');
  assert.equal(kegUrl('https://unraid.tail229434.ts.net', 'keg-007'), 'https://unraid.tail229434.ts.net/kegs/keg-007');
  assert.equal(kegUrl('https://x/', 'keg-1'), 'https://x/kegs/keg-1', 'trailing slash trimmed');
});

test('kegQrSvg reads a pre-generated svg, throws if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qrtest-'));
  process.env.QR_DIR = dir;
  const { kegQrSvg } = await import(`./qr.mjs?fresh=${Date.now()}`);   // fresh import to pick up QR_DIR
  await writeFile(join(dir, 'keg-001.svg'), '<svg>ok</svg>');
  assert.equal(await kegQrSvg('keg-001'), '<svg>ok</svg>');
  await assert.rejects(() => kegQrSvg('keg-999'), /no QR svg/);
  await rm(dir, { recursive: true, force: true });
});
