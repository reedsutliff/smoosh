import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, parse, extname, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.html': 'text/html',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.eot':  'application/vnd.ms-fontobject',
  '.json': 'application/json',
  '.map':  'application/json',
  '.pdf':  'application/pdf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.xml':  'application/xml',
};

// Binary extensions that should be inlined as base64 data URIs
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.pdf',
]);

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

/**
 * Find all local and remote resource references in HTML.
 * Returns [{ raw, resolved, type, remote }]
 */
function extractHtmlRefs(html, baseDir, htmlFilePath) {
  const refs = [];
  const base = htmlFilePath ? dirname(htmlFilePath) : baseDir;

  // <script src="...">
  for (const m of html.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'script', attr: 'src' });
  }
  // <link rel="stylesheet" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-stylesheet', attr: 'href' });
  }
  // <link rel="icon|apple-touch-icon|shortcut icon" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["'](?:icon|apple-touch-icon|shortcut icon)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-icon', attr: 'href' });
  }
  // <img src="..." srcset="...">
  for (const m of html.matchAll(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'img', attr: 'src' });
  }
  // <source src="...">
  for (const m of html.matchAll(/<source[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'source', attr: 'src' });
  }
  // <video src="...">, <audio src="...">
  for (const m of html.matchAll(/<(?:video|audio|track)[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'media', attr: 'src' });
  }
  // <object data="...">
  for (const m of html.matchAll(/<object[^>]*data\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'object', attr: 'data' });
  }
  // <iframe src="..."> (warn only — can't inline iframes)
  for (const m of html.matchAll(/<iframe[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'iframe', attr: 'src' });
  }
  // <a href="..."> pointing to other HTML pages
  for (const m of html.matchAll(/<a[^>]*href\s*=\s*["']([^"']+\.html?)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-page', attr: 'href' });
  }

  // url() references in inline attributes (style="...") and inline <style>
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    refs.push({ raw: m[1], context: 'url()', attr: 'url' });
  }

  return refs.map(r => {
    const raw = r.raw.split('?')[0].split('#')[0]; // strip query/hash
    const isRemote = /^https?:\/\//i.test(raw) || raw.startsWith('//');
    let resolved = null;
    if (!isRemote && !raw.startsWith('data:') && !raw.startsWith('#')) {
      resolved = resolve(base, raw);
    }
    return { ...r, raw, resolved, isRemote };
  });
}

/**
 * Find url() references inside a CSS string.
 */
function extractCssRefs(css, cssFilePath) {
  const refs = [];
  const base = cssFilePath ? dirname(cssFilePath) : process.cwd();
  for (const m of css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    const raw = m[1].split('?')[0].split('#')[0];
    const isRemote = /^https?:\/\//i.test(raw) || raw.startsWith('//');
    let resolved = null;
    if (!isRemote && !raw.startsWith('data:')) {
      resolved = resolve(base, raw);
    }
    refs.push({ raw, resolved, isRemote });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Inlining engine
// ---------------------------------------------------------------------------

function isBinary(ext) {
  return BINARY_EXTS.has(ext);
}

function readAsBase64(filePath) {
  const buf = readFileSync(filePath);
  return buf.toString('base64');
}

function readAsText(filePath) {
  return readFileSync(filePath, 'utf-8');
}

function mimeType(ext) {
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function dataUri(filePath) {
  const ext = extname(filePath).toLowerCase();
  const b64 = readAsBase64(filePath);
  return `data:${mimeType(ext)};base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Asset bundler
// ---------------------------------------------------------------------------

class Bundler {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir;
    this.remote = options.remote || false;
    this.filesBundled = 0;
    this.warnings = [];
    this.bundledFiles = new Set();   // resolved paths already inlined
    this.fetchedUrls = new Set();    // remote URLs already fetched
    this.pages = [];                 // { name, path, relPath } for multi-page
    this.seenPages = new Set();
  }

  warn(severity, message) {
    this.warnings.push({ severity, message });
  }

  /** Resolve a relative path against base, return null if not found */
  resolveLocal(raw, basePath) {
    const resolved = resolve(basePath, raw);
    if (existsSync(resolved)) return resolved;

    // Try common extensions
    for (const ext of ['.html', '.htm', '.js', '.css']) {
      const withExt = resolved + ext;
      if (existsSync(withExt)) return withExt;
    }

    return null;
  }

  /** Fetch a remote URL and return { content, mime, isBinary } */
  async fetchRemote(url) {
    if (this.fetchedUrls.has(url)) return null;
    this.fetchedUrls.add(url);

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        this.warn('warn', `Failed to fetch ${url} (HTTP ${resp.status})`);
        return null;
      }
      const contentType = resp.headers.get('content-type') || '';
      const isBin = !contentType.includes('text/') && !contentType.includes('javascript');
      const content = isBin
        ? Buffer.from(await resp.arrayBuffer()).toString('base64')
        : await resp.text();

      this.filesBundled++;
      return { content, mime: contentType, isBinary: isBin, binary: isBin };
    } catch (err) {
      this.warn('warn', `Failed to fetch ${url}: ${err.message}`);
      return null;
    }
  }

  /** Inline a local file and return its content */
  inlineLocal(filePath) {
    if (this.bundledFiles.has(filePath)) return null;
    this.bundledFiles.add(filePath);

    const ext = extname(filePath).toLowerCase();

    if (isBinary(ext)) {
      this.filesBundled++;
      return { content: readAsBase64(filePath), binary: true, mime: mimeType(ext) };
    }

    this.filesBundled++;
    return { content: readAsText(filePath), binary: false, mime: mimeType(ext) };
  }

  /** Process an HTML file: inline its assets and return the transformed HTML */
  async processHtml(filePath) {
    const html = readAsText(filePath);
    const refs = extractHtmlRefs(html, this.baseDir, filePath);

    // Track which other HTML pages are linked
    const linkedPages = new Set();
    const inlineScripts = [];
    const inlineStyles = [];
    const replacements = [];  // [{ from, to }]

    for (const ref of refs) {
      if (ref.context === 'iframe') {
        this.warn('warn', `Cannot inline iframe: ${ref.raw} — left as-is`);
        continue;
      }

      if (ref.isRemote) {
        if (this.remote) {
          const fetched = await this.fetchRemote(ref.raw);
          if (fetched) {
            if (fetched.binary) {
              const dataUri = `data:${fetched.mime};base64,${fetched.content}`;
              replacements.push({ from: ref.raw, to: dataUri });
            } else {
              // Inline scripts as actual <script> blocks
              if (ref.context === 'script') {
                inlineScripts.push({ src: ref.raw, content: fetched.content });
              } else if (ref.context === 'link-stylesheet') {
                inlineStyles.push({ href: ref.raw, content: fetched.content });
              } else {
                // For other refs that can be inlined as data URIs
                const isImgLike = ['img', 'source', 'media', 'link-icon'].includes(ref.context);
                if (isImgLike && fetched.mime.startsWith('image/')) {
                  replacements.push({ from: ref.raw, to: `data:${fetched.mime};base64,${fetched.content}` });
                }
              }
            }
          }
        }
        continue;
      }

      if (ref.context === 'url()') {
        // url() references inside style attributes — try to resolve
        const resolved = this.resolveLocal(ref.raw, dirname(filePath));
        if (resolved) {
          const ext = extname(resolved).toLowerCase();
          if (isBinary(ext) || ext === '.svg') {
            const mime = mimeType(ext);
            const b64 = readAsBase64(resolved);
            const replacement = `data:${mime};base64,${b64}`;
            this.filesBundled++;
            this.bundledFiles.add(resolved);
            // We'll handle url() replacements via the HTML string
            // Store for later replacement
            replacements.push({ from: `url(${ref.raw})`, to: `url("${replacement}")` });
          } else {
            const content = readAsText(resolved);
            this.filesBundled++;
            this.bundledFiles.add(resolved);
            replacements.push({ from: `url(${ref.raw})`, to: `url("data:${mimeType(ext)};base64,${Buffer.from(content).toString('base64')}")` });
          }
        } else {
          this.warn('warn', `Unresolved url() reference: ${ref.raw} (from ${relative(this.baseDir, filePath)})`);
        }
        continue;
      }

      // Local reference
      const resolved = this.resolveLocal(ref.raw, dirname(filePath));
      if (!resolved) {
        this.warn('error', `Missing local file: ${ref.raw} (from ${relative(this.baseDir, filePath)})`);
        continue;
      }

      const ext = extname(resolved).toLowerCase();

      // Handle linked HTML pages (multi-page support)
      if (ext === '.html' || ext === '.htm') {
        if (!this.seenPages.has(resolved)) {
          this.seenPages.add(resolved);
          linkedPages.add(resolved);
          const relPath = relative(this.baseDir, resolved);
          this.pages.push({
            path: resolved,
            relPath,
            name: parse(resolved).name,
          });
        }
        continue; // Links to pages are rewritten by the runtime
      }

      // Binary files → inline as data URI
      if (isBinary(ext)) {
        const dataUriStr = dataUri(resolved);
        this.bundledFiles.add(resolved);
        this.filesBundled++;
        replacements.push({ from: ref.raw, to: dataUriStr });
        continue;
      }

      // JS files → inline content
      if (ref.context === 'script' && (ext === '.js' || ext === '')) {
        const content = readAsText(resolved);
        this.bundledFiles.add(resolved);
        this.filesBundled++;
        inlineScripts.push({ src: ref.raw, content });
        continue;
      }

      // CSS files → inline content (and recursively process CSS refs)
      if (ref.context === 'link-stylesheet' && ext === '.css') {
        const cssContent = readAsText(resolved);
        this.bundledFiles.add(resolved);
        this.filesBundled++;

        // Recursively inline CSS url() references
        const cssRefs = extractCssRefs(cssContent, resolved);
        let processedCss = cssContent;
        for (const cssRef of cssRefs) {
          if (cssRef.isRemote) {
            if (this.remote) {
              const fetched = await this.fetchRemote(cssRef.raw);
              if (fetched) {
                if (fetched.binary) {
                  processedCss = processedCss.replace(
                    cssRef.raw,
                    `data:${fetched.mime};base64,${fetched.content}`
                  );
                }
              }
            }
            continue;
          }
          const cssResolved = this.resolveLocal(cssRef.raw, dirname(resolved));
          if (cssResolved) {
            const cssExt = extname(cssResolved).toLowerCase();
            if (isBinary(cssExt) || cssExt === '.svg') {
              const b64c = readAsBase64(cssResolved);
              this.bundledFiles.add(cssResolved);
              this.filesBundled++;
              processedCss = processedCss.replace(cssRef.raw, `${mimeType(cssExt)};base64,${b64c}`);
            } else {
              this.warn('warn', `Unexpected CSS url() target: ${cssRef.raw}`);
            }
          } else {
            this.warn('warn', `Unresolved CSS url() reference: ${cssRef.raw}`);
          }
        }

        inlineStyles.push({ href: ref.raw, content: processedCss });
        continue;
      }

      // Other assets (fonts via @font-face src, etc.) — try data URI
      if (['media', 'source', 'link-icon'].includes(ref.context) && isBinary(ext)) {
        const uri = dataUri(resolved);
        this.bundledFiles.add(resolved);
        this.filesBundled++;
        replacements.push({ from: ref.raw, to: uri });
        continue;
      }
    }

    // Apply replacements to HTML
    let resultHtml = html;
    for (const r of replacements) {
      // Replace only the first occurrence to avoid double-replacing
      resultHtml = resultHtml.replace(r.from, r.to);
    }

    // Replace <script src="..."> with inline <script>
    for (const s of inlineScripts) {
      const scriptTag = `<script src="${s.src}"></script>`;
      const scriptTagSingle = `<script src='${s.src}'></script>`;
      const inlineTag = `<script>${s.content}</script>`;
      if (resultHtml.includes(scriptTag)) {
        resultHtml = resultHtml.replace(scriptTag, inlineTag);
      } else if (resultHtml.includes(scriptTagSingle)) {
        resultHtml = resultHtml.replace(scriptTagSingle, inlineTag);
      } else {
        // Try loose matching
        const pattern = new RegExp(`<script[^>]*src\\s*=\\s*["']${escapeRegex(s.src)}["'][^>]*>\\s*</script>`, 'gi');
        resultHtml = resultHtml.replace(pattern, inlineTag);
      }
    }

    // Replace <link rel="stylesheet" href="..."> with inline <style>
    for (const s of inlineStyles) {
      const linkPattern = new RegExp(
        `<link[^>]*rel\\s*=\\s*["']stylesheet["'][^>]*href\\s*=\\s*["']${escapeRegex(s.href)}["'][^>]*\\s*/?>`,
        'gi'
      );
      resultHtml = resultHtml.replace(linkPattern, `<style>${s.content}</style>`);
    }

    // Process linked pages recursively (store their processed HTML)
    for (const pagePath of linkedPages) {
      const subHtml = await this.processHtml(pagePath);
      const pageEntry = this.pages.find(p => p.path === pagePath);
      if (pageEntry) {
        pageEntry.processedHtml = subHtml;
      }
    }

    return resultHtml;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

/**
 * Take a processed entry HTML + collected page data and produce the final
 * self-contained output.
 */
function assembleOutput(entryHtml, entryPath, pages) {
  const entryName = parse(entryPath).name;
  const otherPages = pages.filter(p => p.name !== entryName && p.processedHtml);

  // If only one page, no routing needed — just return the inlined HTML
  if (otherPages.length === 0) {
    return entryHtml;
  }

  // Multi-page: wrap with hash routing runtime
  const pageTemplates = otherPages
    .map(p => `<template id="smoosh-page-${p.name}">${p.processedHtml}</template>`)
    .join('\n');

  const pageNames = JSON.stringify([entryName, ...otherPages.map(p => p.name)]);

  // Inject runtime
  const runtimeScript = `
<script>
(function() {
  const PAGES = ${pageNames};
  let currentPage = null;

  function renderPage(pageName) {
    const el = document.getElementById('smoosh-page-' + pageName);
    if (!el) return;
    const root = document.getElementById('smoosh-root');
    root.innerHTML = el.innerHTML;
    currentPage = pageName;

    // Rewrite links to use hash navigation
    root.querySelectorAll('a[href]').forEach(function(a) {
      var h = a.getAttribute('href');
      if (h && !h.startsWith('#') && !h.startsWith('http') && !h.startsWith('//') && !h.startsWith('data:')) {
        var key = h.replace(/\\.html?$/, '');
        if (PAGES.includes(key)) {
          a.setAttribute('href', '#' + key);
        }
      }
    });

    var t = root.querySelector('title');
    if (t) document.title = t.textContent;
  }

  function navigate() {
    var hash = location.hash.replace(/^#/, '') || PAGES[0] || '';
    if (hash && PAGES.includes(hash)) renderPage(hash);
  }

  window.addEventListener('hashchange', navigate);
  window.addEventListener('DOMContentLoaded', navigate);

  window.__smoosh = {
    navigate: function(p) { location.hash = p; },
    getCurrentPage: function() { return currentPage; },
    getPages: function() { return PAGES.slice(); },
  };
})();
</script>`;

  // Split entry HTML at </body> and inject templates + runtime
  const bodyClose = entryHtml.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    return entryHtml.slice(0, bodyClose) +
      pageTemplates +
      '<div id="smoosh-root" hidden></div>' +
      runtimeScript +
      entryHtml.slice(bodyClose);
  }

  return entryHtml + pageTemplates + '<div id="smoosh-root" hidden></div>' + runtimeScript;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bundle a local HTML site into a single self-contained HTML file.
 *
 * @param {string} inputPath   Path to HTML file or directory
 * @param {object} options
 * @param {string|null} options.outputPath  Output file path (null = auto)
 * @param {boolean} options.remote  Fetch remote resources
 * @param {boolean} options.validateOnly  Only validate, don't produce output
 * @returns {{ outputPath, filesBundled, pageCount, multiPage, warnings, outputSize }}
 */
export async function smoosh(inputPath, options = {}) {
  const { outputPath = null, remote = false, validateOnly = false } = options;

  // Determine entry file
  let entryFile;
  const stat = statSync(inputPath);
  if (stat.isDirectory()) {
    const candidates = ['index.html', 'index.htm'];
    for (const c of candidates) {
      const p = join(inputPath, c);
      if (existsSync(p)) { entryFile = p; break; }
    }
    if (!entryFile) {
      throw new Error(`No index.html found in ${inputPath}`);
    }
  } else {
    entryFile = inputPath;
  }

  const baseDir = stat.isDirectory() ? inputPath : dirname(inputPath);
  const bundler = new Bundler(baseDir, { remote });

  // Process entry HTML and discover assets
  let processedHtml = await bundler.processHtml(entryFile);

  const multiPage = bundler.pages.length > 1;
  const pageCount = bundler.pages.length + 1; // +1 for the entry page

  // Assemble final output
  let finalHtml;
  if (multiPage) {
    finalHtml = assembleOutput(processedHtml, entryFile, bundler.pages, bundler);
  } else {
    finalHtml = processedHtml;
  }

  // Validate: check that no local relative paths remain in the output
  // Strip smoosh template content (managed by runtime) before scanning
  const validationHtml = finalHtml.replace(/<template id="smoosh-page-[^"]*">[\s\S]*?<\/template>/g, '');
  const leftoverRefs = extractHtmlRefs(validationHtml, baseDir, null);
  for (const ref of leftoverRefs) {
    if (ref.context === 'link-page') continue; // handled by runtime
    if (!ref.isRemote && !ref.raw.startsWith('data:') && !ref.raw.startsWith('#') && ref.raw.trim()) {
      // Check if it's a genuinely unresolved local path
      const resolved = bundler.resolveLocal(ref.raw, baseDir);
      if (resolved && existsSync(resolved) && !bundler.bundledFiles.has(resolved)) {
        bundler.warn('error', `Unbundled local reference: ${ref.raw} (${relative(baseDir, resolved)})`);
      }
      // Note: missing files that don't exist are already flagged during
      // the initial scan — no need to warn twice
    }
  }

  if (validateOnly) {
    return {
      warnings: bundler.warnings,
      filesBundled: bundler.filesBundled,
      pageCount,
      multiPage,
    };
  }

  // Write output
  const outPath = outputPath || join(process.cwd(), 'dist', 'index.html');
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  writeFileSync(outPath, finalHtml, 'utf-8');

  return {
    outputPath: resolve(outPath),
    filesBundled: bundler.filesBundled,
    pageCount,
    multiPage,
    warnings: bundler.warnings,
    outputSize: Buffer.byteLength(finalHtml, 'utf-8'),
  };
}
