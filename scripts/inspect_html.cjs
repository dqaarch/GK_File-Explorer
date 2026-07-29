// Check if dump_standalone.html has parse errors
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const html = fs.readFileSync(path.join(__dirname, 'dump_standalone', 'index.html'), 'utf8');

// Extract first script block (before wabc_dump.js)
// Find <script> ... </script> blocks
let pos = 0;
let idx = 0;
const scripts = [];
while (true) {
  const start = html.indexOf('<script', pos);
  if (start < 0) break;
  const end = html.indexOf('</script>', start);
  if (end < 0) break;
  const isExternal = html.substring(start, start + 200).includes('src=');
  const content = html.substring(start, end + 9);
  scripts.push({ idx, start, end, isExternal, len: content.length, first200: content.substring(0, 200) });
  pos = end + 9;
  idx++;
}

console.log('Total <script> tags: ' + scripts.length);
scripts.forEach(s => {
  console.log('  [' + s.idx + '] ' + (s.isExternal ? 'EXTERNAL' : 'INLINE   ') + ' len=' + s.len + ' @ line ' + html.substring(0, s.start).split('\n').length);
  if (!s.isExternal) console.log('     first 100: ' + s.first200.substring(0, 100));
});