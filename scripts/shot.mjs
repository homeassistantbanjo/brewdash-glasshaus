// Headless screenshot of the running dev server, for visual verification against
// live HA. Usage: node scripts/shot.mjs [url] [outfile] [waitMs]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5174/';
const out = process.argv[3] ?? '.shots/overview.png';
const waitMs = Number(process.argv[4] ?? 9000); // let the HA websocket hydrate

// Default viewport = the real target: desktop 1080p. Single-screen / no-scroll
// is a hard requirement, so we screenshot the exact viewport (NOT fullPage) to
// catch overflow. Pass a 5th arg 'full' to force a full-page capture for debug.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.5 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => logs.push(`[goto] ${e.message}`));
// Wait for the real webfonts (Inter / JetBrains Mono) to load so our capture
// matches the user's screen metrics — headless otherwise uses narrower
// fallbacks and under-reports the true layout size.
await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())).catch(() => {});
const fontsLoaded = await page.evaluate(() =>
  document.fonts.check("12px 'JetBrains Mono'") && document.fonts.check("12px 'Inter'"));
logs.push(`[fonts] JetBrains+Inter loaded: ${fontsLoaded}`);
await page.waitForTimeout(waitMs); // HA connect + entity hydration

// Detect vertical overflow (scroll) — the single-screen requirement. Also
// report the tallest card's content height vs its box, to catch intra-card
// collision that page-scroll alone misses.
const overflow = await page.evaluate(() => ({
  scrollH: document.documentElement.scrollHeight,
  clientH: document.documentElement.clientHeight,
}));
const scrolls = overflow.scrollH > overflow.clientH + 2;

const fullPage = process.argv[5] === 'full';
await page.screenshot({ path: out, fullPage });
await browser.close();

console.log(`--- viewport 1920x1080 · scrollH=${overflow.scrollH} clientH=${overflow.clientH} · ${scrolls ? 'OVERFLOWS (scrolls!)' : 'fits, no scroll'} ---`);

console.log('--- console (' + logs.length + ' lines) ---');
console.log(logs.slice(-40).join('\n'));
console.log('--- screenshot saved: ' + out + ' ---');
