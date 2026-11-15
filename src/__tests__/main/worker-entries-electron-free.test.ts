/**
 * A worker thread has no `electron`. In a packaged app the module does not even
 * resolve there, so a value import of it anywhere in a worker's load-time import
 * graph throws before the worker runs a line. Dev and the rest of the suite hide
 * that: `node_modules/electron` resolves in a checkout, and suites mock it.
 * Pianola's memory worker shipped broken this way (it reached `electron` through
 * the session storage readers it shares with main).
 *
 * This walks each worker entry the way `tsc` emits it (CommonJS, imports used
 * only as types dropped) and follows every top-level `require` of a relative
 * module. A `require` inside a function body is lazy and does not run at load,
 * so it is allowed; that is how main-only code such as `getAppUserDataDir()`
 * reaches Electron without loading it in a worker.
 */

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');

const WORKER_ENTRIES = [
	'main/pianola/memory-worker.ts',
	'main/transcript-parse/transcript-parse-worker.ts',
	'main/cue/cue-receipt-worker.ts',
	'main/plugins/plugin-scan-worker.ts',
	'main/plugins/relay-ledger-worker.ts',
	'main/dataview/dataview-query-worker.ts',
];

/** Packages that load `electron` the moment they are required. */
const ELECTRON_BOUND = /^(electron|electron-store|electron-updater|@sentry\/electron)(\/|$)/;

/** Module specifiers a file requires at load time, as the CommonJS build emits it. */
function loadTimeRequires(file: string): string[] {
	const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
		fileName: file,
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
			esModuleInterop: true,
		},
	}).outputText;
	// A load-time require sits in a statement at column 0; a lazy one is
	// indented inside a function body.
	return [...output.matchAll(/^\S.*?\brequire\("([^"]+)"\)/gm)].map((match) => match[1]);
}

function resolveRelative(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/** Each import chain from `entry` that ends in an Electron-bound package. */
function electronChains(entry: string): string[] {
	const chains: string[] = [];
	const seen = new Set<string>();
	const visit = (file: string, chain: string[]) => {
		if (seen.has(file)) return;
		seen.add(file);
		const here = [...chain, path.relative(SRC, file)];
		for (const specifier of loadTimeRequires(file)) {
			if (ELECTRON_BOUND.test(specifier)) {
				chains.push([...here, specifier].join(' -> '));
			} else if (specifier.startsWith('.')) {
				const resolved = resolveRelative(file, specifier);
				if (resolved) visit(resolved, here);
			}
		}
	};
	visit(path.join(SRC, entry), []);
	return chains;
}

describe('worker thread entries never load electron', () => {
	it.each(WORKER_ENTRIES)('%s', (entry) => {
		expect(fs.existsSync(path.join(SRC, entry))).toBe(true);
		expect(electronChains(entry)).toEqual([]);
	});

	it('flags a load-time electron import but not a lazy one', () => {
		const dir = fs.mkdtempSync(path.join(fs.realpathSync(require('os').tmpdir()), 'worker-graph-'));
		try {
			fs.writeFileSync(
				path.join(dir, 'lazy.ts'),
				"export function f() { const { app } = require('electron'); return app; }\n"
			);
			fs.writeFileSync(
				path.join(dir, 'typeonly.ts'),
				"import type Store from 'electron-store';\nexport let s: Store | undefined;\n"
			);
			fs.writeFileSync(
				path.join(dir, 'eager.ts'),
				"import { app } from 'electron';\nexport const p = () => app.getPath('userData');\n"
			);
			fs.writeFileSync(
				path.join(dir, 'entry.ts'),
				"import { f } from './lazy';\nimport { s } from './typeonly';\nimport { p } from './eager';\nexport default [f, s, p];\n"
			);
			const chains = electronChains(path.relative(SRC, path.join(dir, 'entry.ts')));
			expect(chains).toHaveLength(1);
			expect(chains[0]).toMatch(/eager\.ts -> electron$/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
