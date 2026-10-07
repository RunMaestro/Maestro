/**
 * Maestro-lib Part One smoke test.
 *
 * Proves the boundary is honest: nothing under `src/shared/maestro-lib/**`
 * names `electron` (or an `electron/*` subpath) as an import specifier, so a
 * plain program with no Electron/desktop framework present can load and use
 * the library's provider knowledge, parsers, and launch (env/binary-detection/
 * remote-wrapping) surfaces.
 *
 * It also asserts that no specifier in the library resolves into `src/main/**`.
 * Part One left 13 such edges (logger, sentry, execFile, terminalFilter, the
 * SSH resolver and builder, capability snapshots); they were retired by moving
 * the plain Node code into the library and routing the desktop-owned services
 * through `../host.ts`. The `shared-boundary/no-shared-to-main-imports` lint
 * rule enforces the same thing with no allowlist; this scan keeps the
 * guarantee in the test suite as well, where it cannot be disabled per line.
 *
 * Earlier version of this test patched `Module._resolveFilename` and asserted
 * the patch never observed an `electron` request. That patch never fired:
 * `import()` in this Vite-transformed Vitest environment does not go through
 * CommonJS module resolution, so the assertion passed unconditionally and
 * would have kept passing had the library started importing `electron`
 * directly. A source-level scan for the specifier is what actually guards it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LIB_ROOT = path.resolve(__dirname, '..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
// What may sit between the keyword and the quote: whitespace, a block comment,
// or a line comment. A comment is legal everywhere whitespace is, so a scan that
// only allowed `\s` could be walked past with `import /* x */ 'electron'`.
//
// The block-comment form is the linear-time one rather than the obvious
// `\/\*[\s\S]*?\*\/`: the lazy version rescans to end of file when a comment is
// never closed, and it sits inside the separator's `+` loop, so one unterminated
// `/*` would cost that walk again for every `from` or `import` in the file.
const BLOCK_COMMENT = String.raw`/\*[^*]*\*+(?:[^/*][^*]*\*+)*/`;
const LINE_COMMENT = String.raw`//[^\n]*\n`;
const SPECIFIER_SEPARATOR = String.raw`(?:\s|${BLOCK_COMMENT}|${LINE_COMMENT})`;
// Matches the specifier string following `from`, `require(`, `import(`, or a
// bare side-effect `import '...'` - covers static imports, dynamic imports,
// CommonJS requires, and side-effect-only imports alike.
//
// The separator is REQUIRED after `from` and after a bare `import` (a keyword
// has to be delimited from what follows) and OPTIONAL after `require(` and
// `import(` (the paren already delimits it). Collapsing those two cases into one
// optional separator is the trap: it makes the quantifier lazy and direct
// `require('electron')` / `import('electron')` stop matching.
//
// The bare-`import` branch is checked last, so it cannot also match
// `import(...)` (handled above) or `import { x } from`/`import x from` (the
// character after the separator is `{`/an identifier, not a quote).
const IMPORT_SPECIFIER_PATTERN = new RegExp(
	String.raw`(?:from${SPECIFIER_SEPARATOR}+|require\(${SPECIFIER_SEPARATOR}*|import\(${SPECIFIER_SEPARATOR}*|import${SPECIFIER_SEPARATOR}+)['"]([^'"]+)['"]`,
	'g'
);

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(fullPath));
		} else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
			files.push(fullPath);
		}
	}
	return files;
}

function isElectronSpecifier(specifier: string): boolean {
	return specifier === 'electron' || specifier.startsWith('electron/');
}

function findElectronOffenders(source: string): string[] {
	IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
	const specifiers: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = IMPORT_SPECIFIER_PATTERN.exec(source)) !== null) {
		if (isElectronSpecifier(match[1])) {
			specifiers.push(match[1]);
		}
	}
	return specifiers;
}

const SRC_MAIN = path.resolve(LIB_ROOT, '..', '..', 'main') + path.sep;

function findMainOffenders(file: string, source: string): string[] {
	IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
	const specifiers: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = IMPORT_SPECIFIER_PATTERN.exec(source)) !== null) {
		const specifier = match[1];
		if (!specifier.startsWith('.')) {
			continue;
		}
		const resolved = path.resolve(path.dirname(file), specifier);
		if ((resolved + path.sep).startsWith(SRC_MAIN)) {
			specifiers.push(specifier);
		}
	}
	return specifiers;
}

const ENTRY = path.join(LIB_ROOT, 'index.ts');

/** The source file a relative specifier names, or null when it is not a source file. */
function resolveSourceFile(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
		if (SOURCE_EXTENSIONS.has(path.extname(candidate)) && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Every source file the entry reaches through relative imports, inside the
 * library folder or not. The folder scan above misses what the library pulls
 * from the rest of `src/shared`; a consumer of the entry gets all of it.
 */
function collectImportGraph(entry: string): string[] {
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = fs.readFileSync(file, 'utf-8');
		IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IMPORT_SPECIFIER_PATTERN.exec(source)) !== null) {
			if (!match[1].startsWith('.')) continue;
			const resolved = resolveSourceFile(file, match[1]);
			if (resolved) pending.push(resolved);
		}
	}
	return [...seen].sort();
}

describe('maestro-lib: no desktop framework dependency', () => {
	it('has no `electron` import specifier anywhere in the library source', () => {
		const testDir = path.join(LIB_ROOT, '__tests__') + path.sep;
		const offenders: string[] = [];

		for (const file of collectSourceFiles(LIB_ROOT)) {
			if (file.startsWith(testDir)) {
				continue;
			}
			const content = fs.readFileSync(file, 'utf-8');
			for (const specifier of findElectronOffenders(content)) {
				offenders.push(`${path.relative(LIB_ROOT, file)} imports "${specifier}"`);
			}
		}

		expect(offenders).toEqual([]);
	});

	it('has no import specifier that resolves into src/main', () => {
		const testDir = path.join(LIB_ROOT, '__tests__') + path.sep;
		const offenders: string[] = [];

		for (const file of collectSourceFiles(LIB_ROOT)) {
			if (file.startsWith(testDir)) {
				continue;
			}
			const content = fs.readFileSync(file, 'utf-8');
			for (const specifier of findMainOffenders(file, content)) {
				offenders.push(`${path.relative(LIB_ROOT, file)} imports "${specifier}"`);
			}
		}

		expect(offenders).toEqual([]);
	});

	describe('the public entry (index.ts) and everything it imports', () => {
		const graph = collectImportGraph(ENTRY);

		it('reaches modules outside the library folder, so the folder scan alone is not enough', () => {
			expect(graph).toContain(ENTRY);
			expect(graph.some((file) => !file.startsWith(LIB_ROOT + path.sep))).toBe(true);
		});

		it('has no `electron` import specifier', () => {
			const offenders = graph.flatMap((file) =>
				findElectronOffenders(fs.readFileSync(file, 'utf-8')).map(
					(specifier) => `${path.relative(LIB_ROOT, file)} imports "${specifier}"`
				)
			);
			expect(offenders).toEqual([]);
		});

		it('has no file in src/main and no import specifier that resolves into it', () => {
			const offenders = graph.flatMap((file) => [
				...((file + path.sep).startsWith(SRC_MAIN) ? [path.relative(LIB_ROOT, file)] : []),
				...findMainOffenders(file, fs.readFileSync(file, 'utf-8')).map(
					(specifier) => `${path.relative(LIB_ROOT, file)} imports "${specifier}"`
				),
			]);
			expect(offenders).toEqual([]);
		});

		it('loads, and exposes plan, run, stop, outcome, parsers and host hooks', async () => {
			const entry = await import('../index');

			for (const name of [
				'planSessionTurn',
				'startTurn',
				'runTurn',
				'runToCompletion',
				'stopProcess',
				'resolveTurnOutcome',
				'createOutputParser',
				'getOutputParser',
				'setMaestroLibLogger',
			] as const) {
				expect(typeof entry[name], name).toBe('function');
			}
			expect(typeof entry.MAESTRO_LIB_VERSION).toBe('string');
		});
	});

	it('the src/main scan catches a relative import into src/main', () => {
		const file = path.join(LIB_ROOT, 'parsers', 'example.ts');
		expect(findMainOffenders(file, "import { logger } from '../../../main/utils/logger';")).toEqual(
			['../../../main/utils/logger']
		);
		expect(findMainOffenders(file, "import { logger } from '../host';")).toEqual([]);
	});

	it.each([
		["import { app } from 'electron';", 'named static import'],
		['import * as electron from "electron";', 'namespace static import'],
		["import 'electron';", 'bare side-effect import (no `from`, no braces)'],
		['import("electron").then(() => {});', 'dynamic import'],
		["const electron = require('electron');", 'CommonJS require'],
		["import { app } from 'electron/main';", 'electron subpath import'],
		["import /* sneaky */ 'electron';", 'block comment before a bare side-effect specifier'],
		["import { app } from /* sneaky */ 'electron';", 'block comment after `from`'],
		["const electron = require(/* sneaky */ 'electron');", 'block comment inside require'],
		['import(/* sneaky */ "electron");', 'block comment inside a dynamic import'],
		["import // sneaky\n'electron';", 'line comment before a bare side-effect specifier'],
	])('the regex catches "%s" (%s)', (source) => {
		expect(findElectronOffenders(source).length).toBeGreaterThan(0);
	});

	it.each([
		[
			"import { fooElectron } from './fooElectron';",
			'a specifier merely containing the word electron',
		],
		["const x = 'electron';", 'the word electron in an unrelated string literal, not an import'],
	])('the regex does not false-positive on "%s" (%s)', (source) => {
		expect(findElectronOffenders(source)).toEqual([]);
	});

	it('loads provider definitions, capabilities, parsers, and launch helpers and they are usable', async () => {
		const definitions = await import('../providers/definitions');
		const capabilities = await import('../providers/capabilities');
		const parsers = await import('../parsers');
		const pathProber = await import('../launch/path-prober');
		const getShellPathModule = await import('../launch/getShellPath');
		const agentArgs = await import('../launch/agent-args');
		const sshSpawnWrapper = await import('../launch/ssh-spawn-wrapper');

		expect(definitions.getAgentIds().length).toBeGreaterThan(0);
		expect(typeof capabilities.hasCapability).toBe('function');
		expect(typeof parsers.createOutputParser).toBe('function');
		expect(typeof pathProber.checkBinaryExists).toBe('function');
		expect(typeof getShellPathModule.getShellPath).toBe('function');
		expect(typeof agentArgs.buildAgentArgs).toBe('function');
		expect(typeof sshSpawnWrapper.wrapSpawnWithSsh).toBe('function');
	});

	it('loads the stop ladder and the run layer and they are usable', async () => {
		const termination = await import('../control/termination');
		const processTree = await import('../control/process-tree');
		const startTurn = await import('../run/start-turn');
		const runToCompletion = await import('../run/run-to-completion');
		const session = await import('../run/session');

		expect(typeof termination.stopProcess).toBe('function');
		expect(typeof processTree.snapshotProcessTree).toBe('function');
		expect(typeof startTurn.startTurn).toBe('function');
		expect(typeof runToCompletion.runTurn).toBe('function');
		expect(typeof session.planSessionTurn).toBe('function');
	});
});
