// Automated preview check: renders every phase, spams taps, collects console errors.
// Usage: node tools/preview-check.mjs [outDir]   (serves the project folder on :8123)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = resolve(process.argv[2] || join(root, 'preview', 'screens'));
await mkdir(outDir, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.wav': 'audio/wav' };
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
}).listen(8123);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

await page.goto('http://localhost:8123/preview/index.html?manual=1&mute=1');
await page.evaluate(() => document.fonts.ready);
const frame = page.locator('#frame');
const step = (ms) => page.evaluate((ms) => window.__miPo.step(ms), ms);
const shot = async (name) => frame.screenshot({ path: join(outDir, `${name}.png`) });
const stats = () => page.evaluate(() => window.__miPo.stats());

await step(500); await shot('01-intro');
await step(1500); await shot('02-question');         // QUESTION (entering/hold)
await step(800); await shot('03-countdown-3');        // COUNTDOWN 3
await step(760); await shot('04-countdown-2');
await step(760); await shot('05-countdown-1');
await step(600);                                      // → REVEAL
await step(180); await shot('06-now');
await step(2600); await shot('07-waiting-hint');
await page.evaluate(() => document.getElementById('frame').classList.add('show-safe'));
await shot('08-safe-areas');
await page.evaluate(() => document.getElementById('frame').classList.remove('show-safe'));

// Transition: tap, capture the old card leaving and the new one entering.
const before = (await stats()).question;
await page.evaluate(() => window.__miPo.tap());
await step(120); await shot('09-transition-out');
await step(260); await shot('10-transition-in');

// Rapid tap spam during animations: nothing must be accepted until WAITING_FOR_NEXT.
let s = await stats();
const acceptedBefore = s.acceptedTaps;
for (let i = 0; i < 60; i++) { await page.evaluate(() => window.__miPo.tap()); await step(50); }
s = await stats();
const spamAccepted = s.acceptedTaps - acceptedBefore;

// Real pointer taps (mouse click on the frame) while waiting.
while ((await stats()).state !== 'WAITING_FOR_NEXT') await step(200);
const box = await frame.boundingBox();
for (let i = 0; i < 5; i++) await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
const afterClicks = await stats();

// 100 rounds: count immediate repeats.
let repeats = 0, prev = null, rounds = 0;
for (let r = 0; r < 100; r++) {
  while ((await stats()).state !== 'WAITING_FOR_NEXT') await step(400, 40);
  const q = (await stats()).question;
  if (q && prev && q[0] === prev[0]) repeats++;
  prev = q; rounds++;
  await page.evaluate(() => window.__miPo.tap());
}

// RTL sanity: rendered question lines must be laid out right-to-left by the browser.
const rtl = await page.evaluate(() => getComputedStyle(document.getElementById('QuestionText')).direction);

console.log(JSON.stringify({
  firstQuestion: before && before[0],
  spamTapsAccepted: spamAccepted,
  clickBurstAccepted: afterClicks.acceptedTaps - s.acceptedTaps,
  stateAfterClicks: afterClicks.state,
  rounds, immediateRepeats: repeats, direction: rtl,
  consoleProblems: problems,
}, null, 2));
await browser.close();
server.close();
