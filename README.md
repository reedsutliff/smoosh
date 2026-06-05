# smoosh-cli

**Bundle a local HTML site into a single self-contained file — ready to share.**

Send one file. No zip, no server, no extraction.

A developer or agent builds an interactive HTML mockup, a data visualisation, or a dashboard. You want to share it with someone. Instead of zipping up a folder or standing up a server, just run:

```bash
npx smoosh-cli ./my-mockup.html
```

Out comes a single `index.html` — everything inlined, nothing missing. Open it in any browser, send it as an email attachment, put it on a shared drive. Works offline, zero dependencies.

## Install

```bash
npm install -g smoosh-cli
# or use directly:
npx smoosh-cli ./my-site
```

## Usage

```bash
smoosh-cli <input> [options]
```

| Argument | Description |
|----------|-------------|
| `<input>` | HTML file or directory to bundle |

| Option | Description |
|--------|-------------|
| `-o, --output <path>` | Output file path (default: `./dist/index.html`) |
| `--remote` | Fetch and inline remote/CDN resources for offline use |
| `--validate-only` | Scan for unbundled references without producing output |

### Examples

```bash
# Bundle a single HTML mockup
smoosh-cli ./agent-built-mockup.html

# Bundle an entire static site directory
smoosh-cli ./my-site

# Specify output path
smoosh-cli ./dashboard.html -o ~/Desktop/share.html

# Also fetch CDN scripts for offline use
smoosh-cli ./site --remote

# Check that everything's covered (no output)
smoosh-cli ./site --validate-only
```

## What it does

1. **Scans** your HTML for all local dependencies: scripts, stylesheets, images, fonts, icons, SVG favicons, even `url()` references inside CSS
2. **Inlines** them all — JS and CSS become embedded `<script>`/`<style>` blocks, binary assets (images, fonts) become data URIs
3. **Validates** that every local file was found and inlined — warns about anything missed
4. **Handles multi-page sites** — cross-page links are rewritten to hash-based navigation (everything still live in one file)
5. **Optional remote bundling** — `--remote` fetches CDN scripts and styles for fully offline operation

## Example

A typical mockup folder:

```
my-mockup/
├── index.html     ← links to styles.css, app.js, favicon.svg
├── styles.css     ← references background.png via url()
├── app.js
├── favicon.svg
├── analytics.html ← alternate page linked from index.html
└── settings.html  ← alternate page linked from index.html
```

Running `smoosh-cli my-mockup` produces a single `index.html` where every asset is inlined. All local paths are resolved. Open it anywhere.

## Publishing

Tag a release and push to trigger the GitHub Actions publish workflow:

```bash
npm version patch
git push --follow-tags
```

Requires an `NPM_TOKEN` secret in the repo's GitHub settings
(create at https://www.npmjs.com/settings/<username>/tokens,
Automation type — no OTP needed for CI).

## License

MIT
