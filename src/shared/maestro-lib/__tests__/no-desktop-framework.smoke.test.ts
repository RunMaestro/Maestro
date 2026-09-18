/**
 * Maestro-lib Part One smoke test.
 *
 * Proves the boundary is honest: nothing under `src/shared/maestro-lib/**`
 * names `electron` (or an `electron/*` subpath) as an import specifier, so a
 * plain program with no Electron/desktop framework present can load and use
 * the library's provider knowledge, parsers, and launch (env/binary-detection/
 * remote-wrapping) surfaces.
 *
 * This does NOT assert the library is fully free of `src/main/**` imports -
 * see Plans/maestro-lib-part-one-checklist.md for the known residual
 * dependencies on plain Node utilities (logger, sentry, execFile, etc.) that
 * still live under `src/main/utils`. It asserts the one thing that must never
 * regress: no file in the library's source tree imports `electron` itself.
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
// Matches the specifier string following `from`, `require(`, `import(`, or a
// bare side-effect `import '...'` - covers static imports, dynamic imports,
// CommonJS requires, and side-effect-only imports alike. The bare-`import`
// branch is checked last and requires whitespace directly before the quote,
// so it cannot also match `import(...)` (no space) or `import { x } from`/
// `import x from` (the character after the whitespace is `{`/an identifier,
// not a quote) - those are already covered by the other branches.
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]([^'"]+)['"]/g;

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

	it.each([
		["import { app } from 'electron';", 'named static import'],
		['import * as electron from "electron";', 'namespace static import'],
		["import 'electron';", 'bare side-effect import (no `from`, no braces)'],
		['import("electron").then(() => {});', 'dynamic import'],
		["const electron = require('electron');", 'CommonJS require'],
		["import { app } from 'electron/main';", 'electron subpath import'],
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
});
