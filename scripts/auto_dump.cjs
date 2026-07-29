// auto_dump.cjs
// Opens scripts/dump_standalone/index.html in headless Chrome,
// selects RunningCharacter.abc via file picker (programmatically),
// clicks "Load & Dump", waits for output, dumps everything to stdout.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const DUMP_HTML = path.join(ROOT, 'scripts', 'dump_standalone', 'index.html');
const ABC_PATH = process.argv[2] || 'C:\\Users\\Mabu02\\Downloads\\Sample 3D\\RunningCharacter.abc';

if (!fs.existsSync(DUMP_HTML)) {
  console.error('index.html not found: ' + DUMP_HTML);
  process.exit(1);
}
if (!fs.existsSync(ABC_PATH)) {
  console.error('ABC file not found: ' + ABC_PATH);
  console.error('Usage: node scripts/auto_dump.cjs [path-to-abc]');
  process.exit(1);
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--enable-features=SharedArrayBuffer'
    ]
  });

  const page = await browser.newPage();

  // Capture console
  page.on('console', (msg) => {
    console.log('[BROWSER ' + msg.type() + '] ' + msg.text());
  });
  page.on('pageerror', (err) => {
    console.log('[PAGE ERROR] ' + err.message);
  });

  const url = 'http://127.0.0.1:8765/index.html';
  console.log('[AUTO] Opening: ' + url);
  await page.setCacheEnabled(false);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  // Force re-evaluate script load
  const hasWabc = await page.evaluate(() => typeof window.WabcModule);
  console.log('[AUTO] typeof window.WabcModule = ' + hasWabc);

  // Wait for "READY" log
  await page.waitForFunction(() => {
    const out = document.getElementById('output');
    return out && out.textContent.includes('[READY]');
  }, { timeout: 60000 });
  console.log('[AUTO] Module loaded, ready to dump');

  // Set file input
  const fileInput = await page.$('#fileInput');
  await fileInput.uploadFile(ABC_PATH);
  console.log('[AUTO] File uploaded: ' + ABC_PATH);

  // Click Load & Dump
  await page.click('#loadBtn');
  console.log('[AUTO] Clicked Load & Dump');

  // Wait for [DONE]
  await page.waitForFunction(() => {
    const out = document.getElementById('output');
    return out && out.textContent.includes('[DONE]');
  }, { timeout: 120000 });
  console.log('[AUTO] Dump complete');

  // Print final output
  const finalOutput = await page.$eval('#output', el => el.textContent);
  console.log('');
  console.log('================== FINAL OUTPUT ==================');
  console.log(finalOutput);
  console.log('==================================================');

  await browser.close();
})().catch(err => {
  console.error('[FATAL] ' + err.message);
  console.error(err.stack);
  process.exit(1);
});