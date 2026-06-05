import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { smoosh } from '../lib/smoosh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '..', 'tmp-int');

let server, baseUrl;

function serveStatic(dir) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const filePath = join(dir, req.url === '/' ? 'index.html' : req.url);
      try {
        const content = readFileSync(filePath);
        const mime = ({ html: 'text/html', js: 'application/javascript',
          css: 'text/css', png: 'image/png', svg: 'image/svg+xml' })[filePath.split('.').pop()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(content);
      } catch { res.writeHead(404); res.end(''); }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Setup: build test sites
// ---------------------------------------------------------------------------

before(async () => {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

  // 1. Multi-page site with shared JS
  const mp = join(TMP, 'mp');
  mkdirSync(mp, { recursive: true });
  writeFileSync(join(mp, 'index.html'), '<!DOCTYPE html><html><head><title>Home</title></head><body><h1 id="pt">Home Page</h1><a href="p2.html" id="l2">P2</a><p id="out"></p><script src="a.js"></script></body></html>');
  writeFileSync(join(mp, 'p2.html'), '<!DOCTYPE html><html><head><title>Page 2</title></head><body><h1 id="pt">Page 2</h1><a href="index.html" id="lh">Home</a><p id="out"></p><script src="a.js"></script></body></html>');
  writeFileSync(join(mp, 'a.js'), 'document.getElementById("out").textContent = "executed";');
  await smoosh(mp, { outputPath: join(TMP, 'mp.html') });

  // 2. Single page with inline script
  const sp = join(TMP, 'sp');
  mkdirSync(sp, { recursive: true });
  writeFileSync(join(sp, 'index.html'), '<!DOCTYPE html><html><head><title>Simple</title><link rel="stylesheet" href="s.css"></head><body><h1 id="g">Hi</h1><p id="m"></p><script src="a.js"></script></body></html>');
  writeFileSync(join(sp, 'a.js'), 'document.getElementById("m").textContent = "works";');
  writeFileSync(join(sp, 's.css'), 'body{color:#333}');
  await smoosh(sp, { outputPath: join(TMP, 'sp.html') });

  // 3. Interactive page with DOM manipulation
  const ia = join(TMP, 'ia');
  mkdirSync(ia, { recursive: true });
  writeFileSync(join(ia, 'index.html'), '<!DOCTYPE html><html><head><title>Interactive</title></head><body><button id="btn">Click</button><p id="count">0</p><script src="i.js"></script></body></html>');
  writeFileSync(join(ia, 'i.js'), `
var count = 0;
var btn = document.getElementById('btn');
var display = document.getElementById('count');
btn.onclick = function() {
  count++;
  display.textContent = count;
};
display.textContent = 'ready';
`);
  await smoosh(ia, { outputPath: join(TMP, 'ia.html') });

  // 4. Multi-page with interactive content (state test)
  const mpi = join(TMP, 'mpi');
  mkdirSync(mpi, { recursive: true });
  writeFileSync(join(mpi, 'index.html'), '<!DOCTYPE html><html><head><title>M home</title></head><body><h1 id="pt">M Home</h1><a href="other.html" id="lo">Other</a><p id="msg">init</p><script src="m.js"></script></body></html>');
  writeFileSync(join(mpi, 'other.html'), '<!DOCTYPE html><html><head><title>M other</title></head><body><h1 id="pt">M Other</h1><a href="index.html" id="lh">Home</a><p id="msg">other</p><script src="m.js"></script></body></html>');
  writeFileSync(join(mpi, 'm.js'), '');
  await smoosh(mpi, { outputPath: join(TMP, 'mpi.html') });

  // Start server
  baseUrl = await serveStatic(TMP);
});

after(() => {
  if (server) server.close();
});

// ============================================================================
// Multi-page routing
// ============================================================================

describe('multi-page routing', () => {
  let browser, page;

  before(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });

  after(async () => { if (browser) await browser.close(); });

  it('renders the home page on load', async () => {
    await page.goto(baseUrl + '/mp.html');
    await page.waitForSelector('#smoosh-root #pt', { timeout: 5000 });
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Home Page');
  });

  it('executes inlined scripts in the rendered page', async () => {
    assert.equal(await page.locator('#smoosh-root #out').textContent(), 'executed');
  });

  it('navigates to page 2 via runtime-rewritten hash link', async () => {
    await page.locator('#smoosh-root #l2').click();
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => location.hash), '#p2');
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Page 2');
  });

  it('scripts execute on the newly navigated page', async () => {
    assert.equal(await page.locator('#smoosh-root #out').textContent(), 'executed');
  });

  it('navigates back to home', async () => {
    await page.locator('#smoosh-root #lh').click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => location.hash), '#index');
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Home Page');
  });

  it('browser back button works', async () => {
    await page.locator('#smoosh-root #l2').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Page 2');
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Home Page');
  });

  it('browser forward button works', async () => {
    await page.evaluate(() => window.history.forward());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Page 2');
  });

  it('direct URL hash loads the correct page', async () => {
    await page.goto(baseUrl + '/mp.html#p2');
    await page.waitForSelector('#smoosh-root #pt', { timeout: 5000 });
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'Page 2');
  });
});

// ============================================================================
// Single-page inlining
// ============================================================================

describe('single-page inlining', () => {
  let browser, page;

  before(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });

  after(async () => { if (browser) await browser.close(); });

  it('inlines JS and executes it on load', async () => {
    await page.goto(baseUrl + '/sp.html');
    await page.waitForSelector('#m', { timeout: 5000 });
    assert.equal(await page.locator('#m').textContent(), 'works');
  });

  it('inlines CSS into a <style> tag', async () => {
    const html = await page.content();
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('color: #333') || html.includes('color:#333'));
  });
});

// ============================================================================
// Interactive DOM state
// ============================================================================

describe('interactive content', () => {
  let browser, page;

  before(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });

  after(async () => { if (browser) await browser.close(); });

  it('scripts execute and set initial state', async () => {
    await page.goto(baseUrl + '/ia.html');
    await page.waitForSelector('#count', { timeout: 5000 });
    assert.equal(await page.locator('#count').textContent(), 'ready');
  });

  it('event handlers work on inlined content', async () => {
    await page.locator('#btn').click();
    assert.equal(await page.locator('#count').textContent(), '1');
    await page.locator('#btn').click();
    await page.locator('#btn').click();
    assert.equal(await page.locator('#count').textContent(), '3');
  });
});

// ============================================================================
// Multi-page with state preservation
// ============================================================================

describe('multi-page interactive state', () => {
  let browser, page;

  before(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });

  after(async () => { if (browser) await browser.close(); });

  it('renders the first page and executes scripts', async () => {
    await page.goto(baseUrl + '/mpi.html');
    await page.waitForSelector('#smoosh-root #pt', { timeout: 5000 });
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'M Home');
    assert.equal(await page.locator('#smoosh-root #msg').textContent(), 'init');
  });

  it('navigates to other page which has its own state', async () => {
    await page.locator('#smoosh-root #lo').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'M Other');
    assert.equal(await page.locator('#smoosh-root #msg').textContent(), 'other');
  });

  it('navigates back to home page', async () => {
    await page.locator('#smoosh-root #lh').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#smoosh-root #pt').textContent(), 'M Home');
    assert.equal(await page.locator('#smoosh-root #msg').textContent(), 'init');
  });
});

// ============================================================================
// Screenshot tests
// ============================================================================

describe('screenshots', () => {
  let browser, page;

  before(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });

  after(async () => { if (browser) await browser.close(); });

  it('takes screenshot of home page', async () => {
    await page.goto(baseUrl + '/mp.html');
    await page.waitForSelector('#smoosh-root', { timeout: 5000 });
    const shot = await page.screenshot({ path: join(TMP, 'home.png') });
    assert.ok(shot instanceof Buffer && shot.length > 1000);
  });

  it('takes screenshot after navigation', async () => {
    await page.locator('#smoosh-root #l2').click();
    await page.waitForTimeout(400);
    const shot = await page.screenshot({ path: join(TMP, 'page2.png') });
    assert.ok(shot instanceof Buffer && shot.length > 1000);
  });
});
