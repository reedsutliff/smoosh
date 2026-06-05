#!/usr/bin/env node
import { smoosh } from '../lib/smoosh.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

function usage() {
  console.error(`Usage: smoosh <input-dir> [-o <output-dir>]

Bundle a folder of HTML pages into a single self-contained HTML file.

Arguments:
  <input-dir>       Directory containing HTML and JS files to bundle
  -o, --output      Output directory (default: ./dist)

Examples:
  smoosh ./my-site
  smoosh ./my-site -o ./out
`);
  process.exit(1);
}

const inputDir = args[0];
if (!inputDir || inputDir.startsWith('-')) usage();

const outputFlag = args.indexOf('-o');
const outputFlagAlt = args.indexOf('--output');
const outputDir = outputFlag !== -1
  ? args[outputFlag + 1]
  : outputFlagAlt !== -1
    ? args[outputFlagAlt + 1]
    : resolve('dist');

if (!existsSync(resolve(inputDir))) {
  console.error(`Error: input directory "${inputDir}" does not exist`);
  process.exit(1);
}

try {
  const result = await smoosh(resolve(inputDir), resolve(outputDir));
  console.log(`✓ Smooshed ${result.pageCount} pages + ${result.scriptCount} scripts into ${result.outputPath}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
