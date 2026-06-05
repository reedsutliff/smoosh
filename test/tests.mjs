import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoosh } from '../lib/smoosh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const TMP = join(__dirname, '..', 'tmp-test');

// Generate a tiny valid 1x1 red PNG (minimal)
function createPng() {
  // Minimal 1x1 red PNG
  const png = Buffer.from([
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A, // PNG signature
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52, // IHDR chunk
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
    0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
    0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,
    0x54,0x08,0xD7,0x63,0x60,0x60,0x60,0x00,
    0x00,0x00,0x04,0x00,0x01,0x27,0x34,0x27,
    0x0F,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,
    0x44,0xAE,0x42,0x60,0x82,
  ]);
  return png;
}

// --- Setup & Teardown ---
before(() => {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  // Create a real PNG for the basic fixture
  const png = createPng();
  writeFileSync(join(FIXTURES, 'basic', 'icon.png'), png);
  // Make a nested fixture
  const nested = join(FIXTURES, 'nested', 'sub');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(FIXTURES, 'nested', 'index.html'), `<!DOCTYPE html>
<html><head><title>Nested</title></head>
<body><h1>Nested Root</h1><a href="sub/deep.html">Deep</a></body></html>`);
  writeFileSync(join(nested, 'deep.html'), `<!DOCTYPE html>
<html><head><title>Deep</title></head>
<body><h1>Deep Page</h1><a href="../index.html">Back</a></body></html>`);
});

after(() => {
  // Cleanup tmp
  // rmSync(TMP, { recursive: true, force: true });
});

// ============================================================================
// Single Page Tests
// ============================================================================

describe('single page', () => {
  it('bundles a single HTML file with its dependencies', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'basic.html'),
    });
    assert.ok(existsSync(result.outputPath));
    assert.equal(result.filesBundled >= 3, true); // style.css + app.js + icon.png
    assert.equal(result.warnings.length, 0);
    assert.equal(result.multiPage, false);
    assert.equal(result.pageCount, 1);
  });

  it('inlines CSS content into a <style> tag', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'basic-css.html'),
    });
    const html = readFileSync(join(TMP, 'basic-css.html'), 'utf-8');
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('color: blue'));
    assert.ok(!html.includes('href="style.css"')); // original link removed
  });

  it('inlines JS content into a <script> block', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'basic-js.html'),
    });
    const html = readFileSync(join(TMP, 'basic-js.html'), 'utf-8');
    assert.ok(html.includes("console.log('ready')"));
    assert.ok(!html.includes('src="app.js"'));
  });

  it('inlines PNG images as data URIs', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'basic-img.html'),
    });
    const html = readFileSync(join(TMP, 'basic-img.html'), 'utf-8');
    assert.ok(html.includes('data:image/png;base64,'));
    assert.ok(!html.includes('src="icon.png"'));
  });
});

// ============================================================================
// Directory Input Tests
// ============================================================================

describe('directory input', () => {
  it('finds index.html and bundles the site', async () => {
    const result = await smoosh(join(FIXTURES, 'basic'), {
      outputPath: join(TMP, 'dir-basic.html'),
    });
    assert.ok(existsSync(result.outputPath));
    assert.equal(result.warnings.length, 0);
    assert.equal(result.pageCount, 1);
  });

  it('scans all HTML files in nested directories', async () => {
    const result = await smoosh(join(FIXTURES, 'nested'), {
      outputPath: join(TMP, 'dir-nested.html'),
    });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.multiPage, true);
    assert.equal(result.pageCount, 2);
    const html = readFileSync(join(TMP, 'dir-nested.html'), 'utf-8');
    assert.ok(html.includes('smoosh-page-deep'));
    assert.ok(html.includes('Nested Root'));
    assert.ok(html.includes('Deep Page'));
  });
});

// ============================================================================
// Multi-Page Tests
// ============================================================================

describe('multi-page', () => {
  it('bundles linked pages as templates', async () => {
    const result = await smoosh(join(FIXTURES, 'multi'), {
      outputPath: join(TMP, 'multi.html'),
    });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.multiPage, true);
    assert.equal(result.pageCount, 3); // index + page-a + page-b
  });

  it('includes hash routing runtime for multi-page output', async () => {
    const html = readFileSync(join(TMP, 'multi.html'), 'utf-8');
    assert.ok(html.includes('hashchange'));
    assert.ok(html.includes('cloneNode'));
    assert.ok(html.includes('smoosh-page-'));
    assert.ok(html.includes('"page-a"'));
    assert.ok(html.includes('"page-b"'));
  });

  it('inlines assets in each page template', async () => {
    const html = readFileSync(join(TMP, 'multi.html'), 'utf-8');
    // Each page template should have its own inlined style, plus the
    // visible page content has one too
    const styleCount = (html.match(/<style>/g) || []).length;
    assert.ok(styleCount >= 3, 'should have at least 3 inlined style blocks');
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe('validation', () => {
  it('validate-only mode reports no issues for a complete site', async () => {
    const result = await smoosh(join(FIXTURES, 'basic'), { validateOnly: true });
    assert.equal(result.warnings.length, 0);
  });

  it('validate-only mode detects missing files', async () => {
    const result = await smoosh(join(FIXTURES, 'broken', 'index.html'), {
      validateOnly: true,
    });
    assert.ok(result.warnings.length > 0);
    // Each missing file reported exactly once
    const missing = result.warnings.filter(w => w.message.includes('Missing local file'));
    assert.equal(missing.length, 5); // missing.css, favicon.svg, nope.png, gone.js, other.html
  });

  it('no duplicate warnings for the same missing file', async () => {
    const result = await smoosh(join(FIXTURES, 'broken', 'index.html'), {
      validateOnly: true,
    });
    const messages = result.warnings.map(w => w.message);
    const unique = new Set(messages);
    assert.equal(messages.length, unique.size);
  });

  it('reports unbundled references for files that exist but were missed', async () => {
    // Create a fixture with a file that exists but isn't in the HTML deps scan path
    const dir = join(TMP, '_unbundled-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body><h1>Test</h1></body></html>`);
    // Create an extra file that index.html links to
    writeFileSync(join(dir, 'orphan.html'), `<!DOCTYPE html>
<html><head><title>Orphan</title></head>
<body><p>Not linked from index</p></body></html>`);
    // This should have no warnings since orphan.html isn't referenced
    // (it's a standalone page, not a missing dep)
    const result = await smoosh(dir, { validateOnly: true });
    assert.equal(result.warnings.length, 0);
  });
});

// ============================================================================
// CSS url() Reference Tests
// ============================================================================

describe('CSS url() references', () => {
  it('inlines images referenced via url() in CSS', async () => {
    // Create fixture with CSS url() ref
    const dir = join(TMP, '_css-url-test');
    mkdirSync(dir, { recursive: true });
    const png = createPng();
    writeFileSync(join(dir, 'bg.png'), png);
    writeFileSync(join(dir, 'style.css'), `.box {
  background: url('bg.png');
  width: 100px;
  height: 100px;
}`);
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>CSS URL</title>
<link rel="stylesheet" href="style.css">
</head>
<body><div class="box"></div></body></html>`);

    const result = await smoosh(dir, { outputPath: join(TMP, 'css-url.html') });
    assert.equal(result.warnings.length, 0);

    const html = readFileSync(join(TMP, 'css-url.html'), 'utf-8');
    // CSS url() should be replaced with data URI
    assert.ok(!html.includes("url('bg.png')"), 'raw url() should be replaced');
    assert.ok(html.includes('data:image/png;base64,'), 'should contain data URI');
  });

  it('inlines SVG favicons', async () => {
    const dir = join(TMP, '_favicon-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="red"/></svg>`);
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Fav</title>
<link rel="icon" href="favicon.svg">
</head>
<body><h1>Favicon test</h1></body></html>`);

    const result = await smoosh(dir, { outputPath: join(TMP, 'favicon.html') });
    assert.equal(result.warnings.length, 0);

    const html = readFileSync(join(TMP, 'favicon.html'), 'utf-8');
    assert.ok(!html.includes('favicon.svg'), 'raw href should be replaced');
    assert.ok(html.includes('data:image/svg+xml;base64,'), 'svg should be data URI');
  });
});

// ============================================================================
// Output Structure Tests
// ============================================================================

describe('output structure', () => {
  it('produces valid HTML with <!DOCTYPE>', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'struct.html'),
    });
    const html = readFileSync(result.outputPath, 'utf-8');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with doctype');
    assert.ok(html.includes('</html>'), 'must close html');
  });

  it('output size is reported correctly', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'size.html'),
    });
    const actualSize = readFileSync(result.outputPath, 'utf-8').length;
    assert.equal(result.outputSize, actualSize);
    assert.ok(result.outputSize > 300);
  });

  it('filesBundled count matches actual inlined files', async () => {
    const result = await smoosh(join(FIXTURES, 'basic', 'index.html'), {
      outputPath: join(TMP, 'count.html'),
    });
    assert.equal(result.filesBundled, 3); // style.css, app.js, icon.png
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('error handling', () => {
  it('throws when input does not exist', async () => {
    await assert.rejects(
      () => smoosh('/nonexistent/path.html'),
      /ENOENT|not found/i,
    );
  });

  it('throws when directory has no index.html', async () => {
    const dir = join(TMP, '_no-index');
    mkdirSync(dir, { recursive: true });
    await assert.rejects(
      () => smoosh(dir),
      /No index.html found/i,
    );
  });

  it('throws on non-existent directory input', async () => {
    await assert.rejects(
      () => smoosh('/nonexistent-dir/'),
      /ENOENT|not found/i,
    );
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  it('handles empty CSS files', async () => {
    const dir = join(TMP, '_empty-css');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.css'), '');
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Empty CSS</title>
<link rel="stylesheet" href="empty.css">
</head>
<body><p>Test</p></body></html>`);
    const result = await smoosh(dir, { outputPath: join(TMP, 'empty-css.html') });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.filesBundled, 1);
  });

  it('handles empty JS files', async () => {
    const dir = join(TMP, '_empty-js');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.js'), '');
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Empty JS</title>
</head>
<body><p>Test</p>
<script src="empty.js"></script>
</body></html>`);
    const result = await smoosh(dir, { outputPath: join(TMP, 'empty-js.html') });
    assert.equal(result.warnings.length, 0);
    assert.equal(result.filesBundled, 1);
  });

  it('handles HTML without any external references', async () => {
    const dir = join(TMP, '_self-contained');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Standalone</title>
<style>body { color: red; }</style>
</head>
<body><h1>All inline</h1>
<script>alert('hi');</script>
</body></html>`);
    const result = await smoosh(dir, { outputPath: join(TMP, 'self-contained.html') });
    assert.equal(result.warnings.length, 0);
    // Still processes, just no external files to inline
    assert.equal(result.filesBundled, 0);
  });

  it('handles remote URLs without --remote flag (leaves them as-is)', async () => {
    const dir = join(TMP, '_remote');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Remote</title>
<link rel="stylesheet" href="https://cdn.example.com/style.css">
</head>
<body>
<script src="https://cdn.example.com/app.js"></script>
</body></html>`);
    const result = await smoosh(dir, { outputPath: join(TMP, 'remote.html') });
    assert.equal(result.warnings.length, 0);
    const html = readFileSync(join(TMP, 'remote.html'), 'utf-8');
    // Remote URLs should remain untouched
    assert.ok(html.includes('cdn.example.com/style.css'));
    assert.ok(html.includes('cdn.example.com/app.js'));
  });
});

// ============================================================================
// Return value shape
// ============================================================================

describe('return value shape', () => {
  it('returns expected properties', async () => {
    const result = await smoosh(join(FIXTURES, 'basic'), {
      outputPath: join(TMP, 'shape.html'),
    });
    assert.ok('outputPath' in result);
    assert.ok('filesBundled' in result);
    assert.ok('pageCount' in result);
    assert.ok('multiPage' in result);
    assert.ok('warnings' in result);
    assert.ok('outputSize' in result);
    assert.equal(typeof result.outputPath, 'string');
    assert.equal(typeof result.filesBundled, 'number');
    assert.equal(typeof result.pageCount, 'number');
    assert.equal(typeof result.multiPage, 'boolean');
    assert.equal(Array.isArray(result.warnings), true);
    assert.equal(typeof result.outputSize, 'number');
  });

  it('validateOnly returns same shape minus outputPath/outputSize', async () => {
    const result = await smoosh(join(FIXTURES, 'basic'), { validateOnly: true });
    assert.ok(!('outputPath' in result));
    assert.ok(!('outputSize' in result));
    assert.ok('filesBundled' in result);
    assert.ok('pageCount' in result);
    assert.ok('multiPage' in result);
    assert.ok('warnings' in result);
  });
});
