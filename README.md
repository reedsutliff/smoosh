# smoosh

Bundle a folder of HTML pages into a single self-contained HTML file with simulated routing.

## Problem

You have a static site with multiple HTML pages that share JavaScript — something like:

```
site/
├── index.html     ← links to my-page.html
├── my-page.html   ← links back to index.html
└── myjs.js        ← imported by both pages
```

You want to ship it as a single HTML file — no server, no file-access restrictions, just one file that works when opened locally or embedded.

## How it works

`smoosh` scans your input directory, collects every HTML and JS file, then produces **one HTML file** that contains:

- All JS files inlined as `<script>` blocks
- All HTML pages stored as hidden `<template>` elements
- A lightweight JavaScript runtime that provides:
  - **Hash-based routing** — links are rewritten to `#page-name` navigation
  - **On-demand script loading** — each page can declare which JS modules it needs
  - **History API integration** — back/forward works naturally

## Usage

```bash
npx smoosh ./my-site          # outputs ./dist/index.html
npx smoosh ./my-site -o out   # outputs ./out/index.html
```

## Example

Given an input folder:

```
my-site/
├── index.html        ← <script src="myjs.js">, <a href="my-page.html">
├── my-page.html      ← <script src="myjs.js">
└── myjs.js           ← function greet(name) { ... }
```

Running `smoosh my-site` produces a single `index.html` where:

- Clicking the link to `my-page.html` navigates via hash (`#my-page`)
- `myjs.js` is loaded once and shared across all pages
- The URL bar updates so bookmarking works
- No server needed — open the file directly in any browser

## License

MIT
