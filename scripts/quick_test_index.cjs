// Test dump_standalone.html directly
const path = require('path');
const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.on('console', m => console.log('[B] ' + m.text()));
  page.on('pageerror', e => console.log('[PE] ' + e.message));
  await page.goto('file:///' + path.join(__dirname, 'dump_standalone', 'index.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 5000));
  const txt = await page.$eval('#output', el => el.textContent).catch(() => 'no #output');
  console.log('[OUTPUT]:\n' + txt.substring(0, 2000));
  await browser.close();
})();