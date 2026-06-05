#!/usr/bin/env node
import { smoosh } from '../lib/smoosh.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

function usage() {
  console.error(`Usage: smoosh-cli <input> [options]

Bundle a local HTML site into a single self-contained HTML file for sharing.

Arguments:
  <input>       HTML file or directory to bundle

Options:
  -o, --output  <path>    Output file path (default: ./dist/index.html)
  --remote                Fetch and inline remote/CDN resources for offline use
  --validate-only         Check for unbundled local references without producing output
  --help                  Show this help

Examples:
  smoosh-cli ./mockup.html
  smoosh-cli ./my-site
  smoosh-cli ./my-site -o ~/Desktop/share.html
  smoosh-cli ./my-site --remote
  smoosh-cli ./data-viz.html --validate-only
`);
  process.exit(1);
}

const input = args[0];
if (!input || input === '--help' || input === '-h') usage();

const outputFlag = args.indexOf('-o');
const outputFlagAlt = args.indexOf('--output');
const hasOutput = outputFlag !== -1 || outputFlagAlt !== -1;
const outputPath = hasOutput
  ? resolve(args[(outputFlag !== -1 ? outputFlag : outputFlagAlt) + 1])
  : null;

const remote = args.includes('--remote');
const validateOnly = args.includes('--validate-only');

const inputPath = resolve(input);
if (!existsSync(inputPath)) {
  console.error(`Error: "${input}" does not exist`);
  process.exit(1);
}

try {
  const result = await smoosh(inputPath, { outputPath, remote, validateOnly });

  if (validateOnly) {
    if (result.warnings.length === 0) {
      console.log('✓ All local references are bundled — nothing missing');
    } else {
      console.log(`⚠ ${result.warnings.length} issue(s) found:\n`);
      for (const w of result.warnings) {
        console.log(`  ${w.severity === 'error' ? '✗' : '⚠'} ${w.message}`);
      }
    }
  } else {
    console.log(`✓ Bundled into ${result.outputPath}`);
    console.log(`  ${result.filesBundled} files inlined` +
      (result.multiPage ? ` across ${result.pageCount} pages` : ''));
    if (result.warnings.length > 0) {
      console.log(`⚠ ${result.warnings.length} warning(s):`);
      for (const w of result.warnings) {
        console.log(`  ${w.severity === 'error' ? '✗' : '⚠'} ${w.message}`);
      }
    }
    if (result.outputSize) {
      const size = result.outputSize > 1024 * 1024
        ? (result.outputSize / 1024 / 1024).toFixed(1) + ' MB'
        : (result.outputSize / 1024).toFixed(1) + ' KB';
      console.log(`  Size: ${size}`);
    }
    console.log(`  Send this file to anyone — it works offline, no server needed`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
