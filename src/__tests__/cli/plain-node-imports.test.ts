/**
 * Ratchet: `maestro-cli` loads under plain Node.
 *
 * A headless server runs the CLI as `node maestro-cli.js`, not under the
 * Electron binary, and `better-sqlite3` in `node_modules` is rebuilt for
 * Electron's ABI (`postinstall` runs `electron-rebuild`). Under plain Node it
 * cannot load. The bundle keeps it external, so it is only `require`d when the
 * module importing it is evaluated - and esbuild evaluates every STATIC import
 * eagerly at startup. One static path from the entry point to a module that
 * imports `better-sqlite3` would make EVERY verb, including `send` and
 * `run-doc`, die before parsing its arguments.
 *
 * Code that genuinely needs SQLite (the standalone Cue engine's `cue.db`, the
 * stats database) must therefore stay behind a dynamic `import()`. This walks
 * the static graph the way esbuild does and fails on the first reachable
 * importer.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../..');
const ENTRY = path.join(SRC, 'cli/index.ts');

/** Static module specifiers in a source file: value imports, re-exports, top-level require. */
function staticSpecifiers(source: string): string[] {
	// Strip comments so an import inside a doc comment is not followed.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const found: string[] = [];
	const patterns = [
		// import x from 'm' / import { a } from 'm' / import * as x from 'm' (not `import type`)
		/(?:^|[;\n])\s*import\s+(?!type\s)[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
		// import 'm' (side effect)
		/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g,
		// export { a } from 'm' / export * from 'm' (not `export type`)
		/(?:^|[;\n])\s*export\s+(?!type\s)(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g,
		// require('m') - the CommonJS shim and any plain require
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of code.matchAll(pattern)) found.push(match[1]);
	}
	return found;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier.replace(/\?raw$/, ''));
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.cjs`,
		path.join(base, 'index.ts'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/** Every file reachable from `entry` by static imports, with the path that reached it. */
function staticGraph(entry: string): Map<string, string[]> {
	const reached = new Map<string, string[]>([[entry, [entry]]]);
	const queue = [entry];
	// `electron` is aliased to the CLI's shim at build time (scripts/build-cli.mjs).
	const shim = path.join(SRC, 'cli/electron-shim.cjs');
	while (queue.length > 0) {
		const file = queue.shift()!;
		if (/\.(md|json)$/.test(file)) continue;
		for (const specifier of staticSpecifiers(fs.readFileSync(file, 'utf-8'))) {
			let target: string | null = null;
			if (specifier === 'electron') target = shim;
			else if (specifier.startsWith('.')) target = resolveRelative(file, specifier);
			if (!target || reached.has(target)) continue;
			reached.set(target, [...reached.get(file)!, target]);
			queue.push(target);
		}
	}
	return reached;
}

describe('maestro-cli under plain Node', () => {
	const graph = staticGraph(ENTRY);

	it('walks a real graph (guards against a walker that silently finds nothing)', () => {
		const rel = [...graph.keys()].map((f) => path.relative(SRC, f).split(path.sep).join('/'));
		expect(rel).toContain('cli/services/agent-spawner.ts');
		expect(rel).toContain('cli/services/storage.ts');
		expect(graph.size).toBeGreaterThan(100);
	});

	it('detects a static importer when one is reachable (positive control)', () => {
		const fromCueDb = staticGraph(path.join(SRC, 'main/cue/cue-db.ts'));
		const hit = [...fromCueDb.keys()].some((file) =>
			staticSpecifiers(fs.readFileSync(file, 'utf-8')).includes('better-sqlite3')
		);
		expect(hit).toBe(true);
	});

	it('never reaches better-sqlite3 through a static import', () => {
		const offenders = [...graph.entries()]
			.filter(([file]) =>
				staticSpecifiers(fs.readFileSync(file, 'utf-8')).includes('better-sqlite3')
			)
			.map(([, chain]) =>
				chain.map((f) => path.relative(SRC, f).split(path.sep).join('/')).join(' -> ')
			);
		expect(offenders, 'move the SQLite consumer behind a dynamic import()').toEqual([]);
	});
});
