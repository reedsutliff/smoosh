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
 * Detects scripts, stylesheets, images, media, fonts, icons,
 * iframes, page links, url() refs, srcset, preloads, manifests.
 * Returns [{ raw, resolved, type, remote, context }]
 */
function extractHtmlRefs(html, baseDir, htmlFilePath) {
  const refs = [];
  const base = htmlFilePath ? dirname(htmlFilePath) : baseDir;

  // <script src="..."> (handles type="module" and other types)
  for (const m of html.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const typeAttr = (m[0].match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    refs.push({ raw: m[1], context: typeAttr === 'importmap' ? 'importmap' : 'script', attr: 'src' });
  }
  // <link rel="stylesheet" href="..."> (both orders)
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-stylesheet', attr: 'href' });
  }
  for (const m of html.matchAll(/<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-stylesheet', attr: 'href' });
  }
  // <link rel="icon|apple-touch-icon|shortcut icon" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["'](?:icon|apple-touch-icon|shortcut icon)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-icon', attr: 'href' });
  }
  // <link rel="modulepreload" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["']modulepreload["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'modulepreload', attr: 'href' });
  }
  // <link rel="preload|prefetch" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["'](?:preload|prefetch)["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const as = (m[0].match(/\bas\s*=\s*["']([^"']*)["']/i) || [])[1] || 'unknown';
    refs.push({ raw: m[1], context: 'preload', attr: 'href', as });
  }
  // <link rel="manifest" href="...">
  for (const m of html.matchAll(/<link[^>]*rel\s*=\s*["']manifest["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'manifest', attr: 'href' });
  }
  // <link href="..."> generic catch-all for other link types
  for (const m of html.matchAll(/<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["'](?!stylesheet|icon|apple-touch-icon|shortcut icon|modulepreload|preload|prefetch|manifest)([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-other', attr: 'href', rel: m[2] });
  }
  // <img src="...">
  for (const m of html.matchAll(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'img', attr: 'src' });
  }
  // <img srcset="..."> and <source srcset="..."> (CSV of URL [descriptor])
  for (const m of html.matchAll(/<(?:img|source)[^>]*srcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const urls = m[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    for (const url of urls) {
      refs.push({ raw: url, context: 'srcset', attr: 'srcset' });
    }
  }
  // <source src="..."> (picture, audio, video)
  for (const m of html.matchAll(/<source[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'source', attr: 'src' });
  }
  // <video src="...">, <audio src="...">, <track src="...">
  for (const m of html.matchAll(/<(?:video|audio|track)[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'media', attr: 'src' });
  }
  // <object data="...">
  for (const m of html.matchAll(/<object[^>]*data\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'object', attr: 'data' });
  }
  // <embed src="...">
  for (const m of html.matchAll(/<embed[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'embed', attr: 'src' });
  }
  // <iframe src="..."> (warn only — can't inline)
  for (const m of html.matchAll(/<iframe[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'iframe', attr: 'src' });
  }
  // <a href="..."> pointing to other HTML pages
  for (const m of html.matchAll(/<a[^>]*href\s*=\s*["']([^"']+\.html?)["'][^>]*>/gi)) {
    refs.push({ raw: m[1], context: 'link-page', attr: 'href' });
  }
  // Detect <base href="..."> — affects resolution of all relative URLs
  const baseMatch = html.match(/<base[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (baseMatch) {
    refs.push({ raw: baseMatch[1], context: 'base-tag', attr: 'href' });
  }

  // url() references in inline attributes (style="...") and inline <style>
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    refs.push({ raw: m[1], context: 'url()', attr: 'url' });
  }

  return refs.map(r => {
    const raw = r.raw.split('?')[0].split('#')[0]; // strip query/hash
    const isRemote = /^https?:\/\//i.test(raw) || raw.startsWith('//');
    const isAbsolute = raw.startsWith('/');
    let resolved = null;
    if (!isRemote && !raw.startsWith('data:') && !raw.startsWith('#') && !isAbsolute) {
      resolved = resolve(base, raw);
    }
    return { ...r, raw, resolved, isRemote, isAbsolute };
  });
}

/**
 * Find url() references and @import inside a CSS string.
 */
function extractCssRefs(css, cssFilePath) {
  const refs = [];
  const base = cssFilePath ? dirname(cssFilePath) : process.cwd();

  // Strip @import lines before running url() regex to avoid double-matching
  const cssWithoutImports = css.replace(/@import\s+[^;]+;/gi, '');

  // url() references (excluding @import lines)
  for (const m of cssWithoutImports.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    const raw = m[1].split('?')[0].split('#')[0];
    const isRemote = /^https?:\/\//i.test(raw) || raw.startsWith('//');
    let resolved = null;
    if (!isRemote && !raw.startsWith('data:')) {
      resolved = resolve(base, raw);
    }
    refs.push({ raw, resolved, isRemote });
  }
  // @import url(...) or @import "..." 
  for (const m of css.matchAll(/@import\s+(?:url\(["']?([^"')]+)["']?\)|["']([^"']+)["'])\s*;?/gi)) {
    const raw = (m[1] || m[2]).split('?')[0].split('#')[0];
    const isRemote = /^https?:\/\//i.test(raw) || raw.startsWith('//');
    let resolved = null;
    if (!isRemote && !raw.startsWith('data:')) {
      resolved = resolve(base, raw);
    }
    refs.push({ raw, resolved, isRemote, isImport: true });
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
      // --- Unsupported / warn-only ref types ---
      if (ref.context === 'iframe') {
        this.warn('warn', `iframe cannot be inlined (src="${ref.raw}") — left as-is`);
        continue;
      }
      if (ref.context === 'embed') {
        this.warn('warn', `<embed src="${ref.raw}"> cannot be inlined — left as-is`);
        continue;
      }
      if (ref.context === 'manifest') {
        this.warn('warn', `Web app manifest (href="${ref.raw}") cannot be inlined — left as-is`);
        continue;
      }
      if (ref.context === 'base-tag') {
        this.warn('warn', `<base href="${ref.raw}"> detected — relative URL resolution in the original site used this base; smoosh resolves from file location instead`);
        continue;
      }
      if (ref.context === 'preload') {
        this.warn('warn', `<link rel="preload" href="${ref.raw}" as="${ref.as}"> — inlining the resource but the preload hint is lost`);
        // Fall through to inline the resource if possible
      }
      if (ref.context === 'link-other') {
        this.warn('warn', `<link rel="${ref.rel}" href="${ref.raw}"> is not supported for inlining — left as-is`);
        continue;
      }
      if (ref.context === 'importmap') {
        this.warn('warn', `<script type="importmap" src="${ref.raw}"> not supported for inlining — left as-is`);
        continue;
      }
      if (ref.context === 'modulepreload') {
        // Treat like a script — inline it
        // (context changes to 'script' so the local ref handler picks it up)
        ref.context = 'script';
      }

      // Remote refs
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

      // Absolute paths — warn, can't resolve
      if (ref.isAbsolute) {
        this.warn('warn', `Absolute path "${ref.raw}" cannot be resolved — left as-is (serve the original site from a web server)`);
        continue;
      }

      // srcset — can't meaningfully inline (pixel density descriptors lost)
      if (ref.context === 'srcset') {
        this.warn('warn', `srcset URL "${ref.raw}" not inlined (pixel/density descriptors can't map to data URIs) — left as-is`);
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
        if (!this.seenPages.has(resolved) && resolved !== filePath) {
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
            if (cssRef.isImport) {
              // @import — warn and skip (would need recursive resolution)
              this.warn('warn', `CSS @import "${cssRef.raw}" not inlined (recursive CSS resolution not supported)`);
              continue;
            }
            if (isBinary(cssExt) || cssExt === '.svg') {
              const b64c = readAsBase64(cssResolved);
              this.bundledFiles.add(cssResolved);
              this.filesBundled++;
              processedCss = processedCss.replace(cssRef.raw, `data:${mimeType(cssExt)};base64,${b64c}`);
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
function assembleOutput(entryHtml, entryName, allPages) {
  // allPages: [{ name, processedHtml }] — includes the entry page too
  const pageNames = JSON.stringify(allPages.map(p => p.name));

  // Build templates for all pages (including entry — we template it too)
  let pageTemplates = allPages.map(p =>
    `<template id="smoosh-page-${p.name}">${p.processedHtml}</template>`
  ).join('\n');

  // Inject runtime — properly executes scripts from templates
  const runtimeScript = `
<script>
(function() {
  var PAGES = ${pageNames};
  var currentPage = null;

  function renderPage(pageName) {
    var el = document.getElementById('smoosh-page-' + pageName);
    if (!el) return;
    currentPage = pageName;

    var root = document.getElementById('smoosh-root');
    var content = el.content.cloneNode(true);

    // Collect scripts to re-execute after DOM insertion
    var scripts = [];
    content.querySelectorAll('script').forEach(function(s) {
      scripts.push({ src: s.src, text: s.textContent });
      s.remove();
    });

    // Clear root and append the live content (without scripts)
    root.innerHTML = '';
    root.appendChild(content);

    // Now execute scripts by creating fresh script elements in the document
    scripts.forEach(function(s) {
      var newScript = document.createElement('script');
      if (s.src) {
        newScript.src = s.src;
      } else {
        newScript.textContent = s.text;
      }
      document.body.appendChild(newScript);
    });

    // Rewrite links to use hash navigation
    root.querySelectorAll('a[href]').forEach(function(a) {
      var h = a.getAttribute('href');
      if (h && !h.startsWith('#') && !h.startsWith('http') && !h.startsWith('//') && !h.startsWith('data:')) {
        var key = h.replace(/\\.html?$/, '');
        if (PAGES.indexOf(key) !== -1) {
          a.setAttribute('href', '#' + key);
        }
      }
    });

    var t = root.querySelector('title');
    if (t) document.title = t.textContent;
  }

  function navigate() {
    var hash = location.hash.replace(/^#/, '') || PAGES[0] || '';
    if (hash && PAGES.indexOf(hash) !== -1) renderPage(hash);
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

  // --- Deduplication: move shared <style> and <script> from templates to head ---

  // Collect style content from each template (excluding the head style block
  // which is already in the document head of entryHtml)
  const templateStyleMap = new Map(); // contentHash -> { count, firstTemplateName, content }

  function contentHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
    return h;
  }

  // Scan templates for <style> and <script> content
  for (const p of allPages) {
    // Extract <style> blocks from template content
    const styleRegex = /<style>([\s\S]*?)<\/style>/g;
    let m;
    while ((m = styleRegex.exec(p.processedHtml)) !== null) {
      const content = m[1].trim();
      const hash = contentHash(content);
      if (!templateStyleMap.has(hash)) {
        templateStyleMap.set(hash, { count: 0, content, names: [] });
      }
      templateStyleMap.get(hash).count++;
      templateStyleMap.get(hash).names.push(p.name);
    }
  }

  // Find shared styles (appearing in more than one template)
  const sharedStyles = [];
  for (const [hash, info] of templateStyleMap) {
    if (info.count > 1) {
      sharedStyles.push(info.content);
    }
  }

  // If we have shared styles, inject them into the entry head and remove from templates
  if (sharedStyles.length > 0) {
    // BUT first check which shared styles are already in the entry head
    const headStyles = [];
    const headStyleRegex = /<style>([\s\S]*?)<\/style>/g;
    let hm;
    while ((hm = headStyleRegex.exec(entryHtml)) !== null) {
      headStyles.push(hm[1].trim());
    }

    const actuallyShared = sharedStyles.filter(ss => !headStyles.includes(ss));

    if (actuallyShared.length > 0) {
      const sharedStyleBlock = actuallyShared.map(c => `<style>${c}</style>`).join('\n');
      // Inject into <head> before </head>
      entryHtml = entryHtml.replace('</head>', sharedStyleBlock + '\n</head>');
    }

    // Remove shared style blocks from templates (whether already in head or not)
    for (let i = 0; i < allPages.length; i++) {
      for (const shared of sharedStyles) {
        allPages[i].processedHtml = allPages[i].processedHtml.replace(
          new RegExp(`<style>${escapeRegex(shared)}</style>`, 'g'), ''
        );
      }
    }
    // Also rebuild pageTemplates
    pageTemplates = allPages.map(p =>
      `<template id="smoosh-page-${p.name}">${p.processedHtml}</template>`
    ).join('\n');
  }

  // The runtime renders the initial page from its template on DOMContentLoaded.
  // We replace the body content with templates + root + runtime.
  // The <head> content (title, meta, <style>) is kept intact.
  const afterHead = entryHtml.indexOf('</head>');
  const bodyOpen = entryHtml.indexOf('<body', afterHead);
  const bodyClose = entryHtml.lastIndexOf('</body>');

  if (bodyOpen !== -1 && bodyClose !== -1) {
    const bodyOpenEnd = entryHtml.indexOf('>', bodyOpen) + 1;
    // Keep everything before <body> (includes <head> with styles)
    const headAndOpen = entryHtml.slice(0, bodyOpenEnd);
    // Keep everything after </body> (nothing usually, but be safe)
    const afterBody = entryHtml.slice(bodyClose);
    return headAndOpen +
      pageTemplates +
      '<div id="smoosh-root"><!-- pages rendered here --></div>' +
      runtimeScript +
      afterBody;
  }

  return entryHtml + pageTemplates + '<div id="smoosh-root"></div>' + runtimeScript;
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
  const stat = statSync(inputPath);

  // Determine base directory and entry file
  let baseDir, entryFile;
  if (stat.isDirectory()) {
    baseDir = inputPath;
    entryFile = join(inputPath, 'index.html');
    if (!existsSync(entryFile)) {
      // Try index.htm
      entryFile = join(inputPath, 'index.htm');
      if (!existsSync(entryFile)) {
        throw new Error(`No index.html found in ${inputPath}`);
      }
    }
  } else {
    entryFile = inputPath;
    baseDir = dirname(inputPath);
  }

  const bundler = new Bundler(baseDir, { remote });

  // Process entry HTML and discover assets
  const entryProcessed = await bundler.processHtml(entryFile);
  const entryName = parse(entryFile).name;

  // If directory input, scan ALL HTML files to catch orphans
  if (stat.isDirectory()) {
    const allHtml = [];
    function scanDir(dir) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          if (!entry.startsWith('.') && entry !== 'node_modules') scanDir(full);
        } else if (/\.html?$/i.test(entry)) {
          allHtml.push(full);
        }
      }
    }
    scanDir(baseDir);

    // Process any HTML files not already seen
    for (const htmlPath of allHtml) {
      if (!bundler.seenPages.has(htmlPath) && htmlPath !== entryFile) {
        bundler.seenPages.add(htmlPath);
        const name = parse(htmlPath).name;
        // Process it to inline its assets
        const processed = await bundler.processHtml(htmlPath);
        bundler.pages.push({
          path: htmlPath,
          relPath: relative(baseDir, htmlPath),
          name,
          processedHtml: processed,
        });
      }
    }
  }

  // Collect all pages (including entry) for the assembly
  const allPages = [
    { name: entryName, processedHtml: entryProcessed },
    ...bundler.pages.filter(p => p.name !== entryName && p.processedHtml),
  ];

  // Assemble final output
  const finalHtml = allPages.length > 1
    ? assembleOutput(entryProcessed, entryName, allPages)
    : entryProcessed;

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
      pageCount: allPages.length,
      multiPage: allPages.length > 1,
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
    pageCount: allPages.length,
    multiPage: allPages.length > 1,
    warnings: bundler.warnings,
    outputSize: Buffer.byteLength(finalHtml, 'utf-8'),
  };
}
