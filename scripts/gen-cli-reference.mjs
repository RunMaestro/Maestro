// Generate docs/cli-reference.md from the live CLI command tree.
//
// Builds the CLI bundle (so the reference reflects the current source) then runs
// `maestro-cli reference` and writes the Markdown to docs/cli-reference.md. The
// reference is introspected from Commander, so it can never drift from the
// registered commands.
//
// Usage: npm run gen:cli-reference

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliBundle = join(rootDir, 'dist/cli/maestro-cli.js');
const outFile = join(rootDir, 'docs/cli-reference.md');

console.log('Building CLI bundle...');
execFileSync('node', [join(rootDir, 'scripts/build-cli.mjs')], { stdio: 'inherit' });

console.log('Generating command reference...');
const markdown = execFileSync('node', [cliBundle, 'reference'], {
	encoding: 'utf8',
	maxBuffer: 16 * 1024 * 1024,
});

writeFileSync(outFile, markdown.endsWith('\n') ? markdown : markdown + '\n', 'utf8');
console.log(`Wrote ${outFile}`);
