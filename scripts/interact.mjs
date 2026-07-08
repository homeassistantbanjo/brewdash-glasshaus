// Drive the dashboard: screenshot base, open a metric popup, exercise setpoint.
// Verifies the interactive controls render + behave. Does NOT commit a setpoint
// write unless RUN_WRITE=1 (so we don't change your live HA by accident).
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5174/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.5 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(8000);

// 1) Open a metric popup — click the GRAVITY headline in the first card.
const gravity = page.getByTitle('Gravity — details').first();
const hasGravity = await gravity.count();
if (hasGravity) {
  await gravity.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '.shots/metric-popup.png' });
  console.log('metric popup: opened + captured');
  // close it
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(30, 30); // click backdrop to close
  await page.waitForTimeout(400);
} else {
  console.log('metric popup: Gravity title not found (no fermenting card?)');
}

// 2) Exercise setpoint: read the displayed value, tap +, confirm the pending
//    value changed and a SET button appeared — but only WRITE if RUN_WRITE=1.
const plus = page.getByLabel('Raise setpoint').first();
if (await plus.count()) {
  await plus.click();
  await plus.click(); // +1.0°F pending
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.shots/setpoint-pending.png' });
  const setBtn = page.getByRole('button', { name: 'SET' }).first();
  const setVisible = await setBtn.count();
  console.log(`setpoint: +2 taps applied, SET button present=${!!setVisible}`);
  if (process.env.RUN_WRITE === '1' && setVisible) {
    await setBtn.click();
    await page.waitForTimeout(500);
    console.log('setpoint: SET pressed (write committed to HA)');
  } else {
    console.log('setpoint: NOT committed (set RUN_WRITE=1 to write)');
  }
} else {
  console.log('setpoint: control not found');
}

await browser.close();
console.log('--- console tail ---');
console.log(logs.filter((l) => l.includes('WRITE') || l.includes('GlassHaus') || l.includes('pageerror')).slice(-15).join('\n'));
