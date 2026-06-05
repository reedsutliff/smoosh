import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, parse, resolve } from 'node:path';

/**
 * Scan a directory recursively, returning all HTML and JS file paths.
 */
function scanDir(dir) {
  const pages = [];   // { path, relPath, name }
  const scripts = []; // { path, relPath, name }

  function walk(currentPath) {
    for (const entry of readdirSync(currentPath)) {
      const fullPath = join(currentPath, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = parse(entry).ext.toLowerCase();
        if (ext === '.html') {
          pages.push({
            path: fullPath,
            relPath: relative(dir, fullPath),
            name: parse(entry).name,
          });
        } else if (ext === '.js') {
          scripts.push({
            path: fullPath,
            relPath: relative(dir, fullPath),
            name: parse(entry).name,
          });
        }
      }
    }
  }

  walk(dir);
  return { pages, scripts };
}

/**
 * Generate the output HTML by bundling pages and scripts
 * into a single self-contained file.
 */
function bundle(pages, scripts, runtimeTemplate) {
  // Collect script contents keyed by their relative path
  const scriptContents = {};
  for (const s of scripts) {
    scriptContents[s.relPath] = readFileSync(s.path, 'utf-8');
  }

  // Collect page contents (as raw HTML strings) keyed by page name
  const pageContents = {};
  for (const p of pages) {
    pageContents[p.name] = readFileSync(p.path, 'utf-8');
  }

  // Build script injection blocks from deduplicated scripts
  const scriptBlocks = scripts.map(s => {
    return `<script id="smoosh-script-${s.name}" data-smoosh>${scriptContents[s.relPath]}</script>`;
  }).join('\n');

  // Build template blocks for each page
  const templateBlocks = pages.map(p => {
    return `<template id="smoosh-page-${p.name}" data-smoosh>${pageContents[p.name]}</template>`;
  }).join('\n');

  // Build page-to-scripts mapping for the runtime
  const pageScriptMap = {};
  for (const p of pages) {
    const html = pageContents[p.name];
    // Find <script src="..."> references in the page
    const srcRefs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi)]
      .map(m => parse(m[1]).name);
    pageScriptMap[p.name] = srcRefs;
  }

  const scriptNames = JSON.stringify(Object.keys(scriptContents));
  const pageScriptMapJson = JSON.stringify(pageScriptMap);
  const pageNames = JSON.stringify(pages.map(p => p.name));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pages[0]?.name || 'smoosh'}</title>
<style data-smoosh>
  [data-smoosh-page] { display: none; }
  [data-smoosh-page].active { display: block; }
</style>
</head>
<body>

<!-- smoosh: inlined scripts -->
${scriptBlocks}

<!-- smoosh: bundled pages as templates -->
${templateBlocks}

<!-- smoosh: render target -->
<div id="smoosh-root"></div>

<!-- smoosh: runtime -->
<script data-smoosh>
(function() {
  const PAGES = ${pageNames};
  const ALL_SCRIPTS = ${scriptNames};
  const PAGE_SCRIPTS = ${pageScriptMapJson};

  let currentPage = null;
  let loadedScripts = new Set();

  function loadScript(name) {
    if (loadedScripts.has(name)) return;
    const el = document.getElementById('smoosh-script-' + name);
    if (!el) return;
    // Clone the script element to execute it
    const script = document.createElement('script');
    script.textContent = el.textContent;
    document.body.appendChild(script);
    loadedScripts.add(name);
  }

  function renderPage(pageName) {
    const template = document.getElementById('smoosh-page-' + pageName);
    if (!template) return;

    // Load required scripts for this page
    const deps = PAGE_SCRIPTS[pageName] || [];
    deps.forEach(loadScript);

    // Render the page content
    const root = document.getElementById('smoosh-root');
    root.innerHTML = template.innerHTML;
    currentPage = pageName;

    // Rewrite relative links to hash navigation
    root.querySelectorAll('a[href]').forEach(function(a) {
      var href = a.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('//')) {
        var pageKey = href.replace(/\\.html$/, '');
        if (PAGES.includes(pageKey)) {
          a.setAttribute('href', '#' + pageKey);
        }
      }
    });

    // Mark active page
    document.querySelectorAll('[data-smoosh-page]').forEach(function(el) {
      el.classList.remove('active');
    });
    root.setAttribute('data-smoosh-page', pageName);
    root.classList.add('active');

    // Update document title if the page has one
    var titleEl = root.querySelector('title');
    if (titleEl) document.title = titleEl.textContent;
  }

  function navigate() {
    var hash = location.hash.replace(/^#/, '') || PAGES[0] || '';
    if (hash && PAGES.includes(hash)) {
      renderPage(hash);
    }
  }

  window.addEventListener('hashchange', navigate);
  window.addEventListener('DOMContentLoaded', navigate);

  // Expose smoosh API for programmatic use
  window.__smoosh = {
    navigate: function(page) { location.hash = page; },
    getCurrentPage: function() { return currentPage; },
    getPages: function() { return PAGES.slice(); },
    loadScript: loadScript,
  };
})();
</script>
</body>
</html>`;
}

/**
 * Main entry: smoosh an input directory into a single output HTML file.
 *
 * @param {string} inputDir   Path to the directory containing HTML/JS files
 * @param {string} outputDir  Path to the output directory (will be created if needed)
 * @returns {{ outputPath: string, pageCount: number, scriptCount: number }}
 */
export async function smoosh(inputDir, outputDir) {
  if (!existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const { pages, scripts } = scanDir(inputDir);

  if (pages.length === 0) {
    throw new Error('No HTML files found in input directory');
  }

  const html = bundle(pages, scripts);

  const outDir = resolve(outputDir);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const outputPath = join(outDir, 'index.html');
  writeFileSync(outputPath, html, 'utf-8');

  return {
    outputPath,
    pageCount: pages.length,
    scriptCount: scripts.length,
  };
}
