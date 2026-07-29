// Quick test: load test2.html in chrome and dump content
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
  await page.goto('file:///' + path.join(__dirname, 'dump_standalone', 'test2.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 2000));
  const txt = await page.$eval('#o', el => el.textContent);
  console.log('[O]: ' + txt);
  await browser.close();
})();