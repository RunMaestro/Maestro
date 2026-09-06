#!/usr/bin/env node
// Verifies that every `src/...` path asserted in the agent documentation still
// resolves on disk. These files are loaded into every agent session as ground
// truth; a stale path teaches an agent to import from a file that no longer
// exists. Run via `npm run docs:verify`. Exits non-zero on any missing path.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['CLAUDE.md', 'docs/agent-guides/CANONICAL-UTILITIES.md'];

let missing = 0;
let checked = 0;
for (const doc of docs) {
	const text = readFileSync(resolve(root, doc), 'utf8');
	const paths = new Set(
		[...text.matchAll(/`(src\/[A-Za-z0-9_/.-]+\.(?:ts|tsx|md))`/g)].map((m) => m[1])
	);
	for (const p of paths) {
		checked++;
		if (!existsSync(resolve(root, p))) {
			missing++;
			console.error(`MISSING: ${p} (asserted in ${doc})`);
		}
	}
}

console.log(`docs:verify checked ${checked} asserted paths, ${missing} missing`);
process.exit(missing === 0 ? 0 : 1);
