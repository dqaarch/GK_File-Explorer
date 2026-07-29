// Test dump_standalone.html but check wabc_dump.js directly
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
  page.on('requestfailed', r => console.log('[REQFAIL] ' + r.url() + ' :: ' + r.failure().errorText));
  page.on('response', r => console.log('[RESP] ' + r.status() + ' ' + r.url()));

  await page.goto('file:///' + path.join(__dirname, 'dump_standalone', 'test3.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));

  // Try evaluating window.WabcModule in page directly
  const result = await page.evaluate(() => {
    return {
      WabcModule: typeof window.WabcModule,
      keys: Object.keys(window).filter(k => k.includes('abc') || k.includes('Module') || k.includes('wasm')).join(','),
      docScripts: Array.from(document.scripts).map(s => s.src || 'inline')
    };
  });
  console.log('[RESULT]:', JSON.stringify(result, null, 2));

  await browser.close();
})();