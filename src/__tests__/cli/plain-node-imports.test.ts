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
import { formatChain, staticGraph, staticSpecifiers } from '../helpers/staticImportGraph';

const SRC = path.join(__dirname, '../..');
const ENTRY = path.join(SRC, 'cli/index.ts');
// `electron` is aliased to the CLI's shim at build time (scripts/build-cli.mjs).
const SHIM = path.join(SRC, 'cli/electron-shim.cjs');
const cliGraph = (entry: string) =>
	staticGraph(entry, (specifier) => (specifier === 'electron' ? SHIM : null));

describe('maestro-cli under plain Node', () => {
	const graph = cliGraph(ENTRY);

	it('walks a real graph (guards against a walker that silently finds nothing)', () => {
		const rel = [...graph.keys()].map((f) => path.relative(SRC, f).split(path.sep).join('/'));
		expect(rel).toContain('cli/services/agent-spawner.ts');
		expect(rel).toContain('cli/services/storage.ts');
		expect(graph.size).toBeGreaterThan(100);
	});

	it('detects a static importer when one is reachable (positive control)', () => {
		const fromCueDb = cliGraph(path.join(SRC, 'main/cue/cue-db.ts'));
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
			.map(([, chain]) => formatChain(chain, SRC));
		expect(offenders, 'move the SQLite consumer behind a dynamic import()').toEqual([]);
	});

	it('loads media settings validation without pulling in the Dictation runtime', () => {
		expect(graph.has(path.join(SRC, 'main/plugins/plugin-media-tools.ts'))).toBe(true);
		expect(graph.has(path.join(SRC, 'main/local-models/dictation.ts'))).toBe(false);
	});
});
